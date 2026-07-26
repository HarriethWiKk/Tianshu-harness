import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { MonitorRegistry } from '../monitor-registry.js'

/**
 * Monitor Hook — preTurn 事件投递。
 *
 * 每个 API 轮边界从 MonitorRegistry drain 待投事件（双上限闩锁：总量 ≤2、
 * 单 monitor ≤2，溢出留队下轮再投），经 advisory bus 的 system-reminder
 * 通道注入——模型必读、尾部追加、前缀缓存安全。
 *
 * 通道纪律：
 * - srClass 'functional'（不限流）——闩锁由 drain 上限自带，不占 discipline
 *   每轮 1 条的额度、也不会被限流吞掉事件。
 * - key 含 registry 单调序号（monitor-<id>-<seq>）——bus 同 key 同轮去重，
 *   裸 id 会让同 monitor 的事件互相覆盖。
 * - immediate: true——事件是既成事实，不走挂起观察。
 */
export interface MonitorHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  getMonitors: () => MonitorRegistry | undefined
}

const KIND_LABEL: Record<string, string> = {
  match: 'pattern 命中',
  output: '新输出',
  exit: '任务终态',
  overflow: '输出合并',
}

export function createMonitorHook(deps: MonitorHookDeps): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'monitor-events',
    run(_ctx: RuntimeHookContext) {
      const monitors = deps.getMonitors()
      if (!monitors?.hasActive()) return
      for (const ev of monitors.drainEvents()) {
        deps.advisoryBus.submit({
          key: `monitor-${ev.monitorId}-${ev.seq}`,
          priority: 0.55,
          category: 'monitor',
          tier: 'operational',
          channel: 'system-reminder',
          srClass: 'functional',
          immediate: true,
          content: `[monitor ${ev.monitorId}] ${KIND_LABEL[ev.kind] ?? ev.kind}（job ${ev.jobId}）：\n${ev.text}`,
        })
      }
    },
  }
}
