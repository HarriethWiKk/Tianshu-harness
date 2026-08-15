// office-docx: Native .docx read/write via docx (generation) + mammoth (extraction)
// Mirrors the dsh-office docx_create/docx_read tools (0.1.5).

import { existsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

// ── Helpers ──────────────────────────────────────────────────────

function toCellText(val) {
  if (val === null || val === undefined) return ''
  return String(val)
}

// ── docx_create ─────────────────────────────────────────────────

async function docxCreate(params) {
  const dest = params?.destination_path
  if (!dest) return { content: 'Error: destination_path is required', isError: true }

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import('docx')

    const children = []
    if (params.title) {
      children.push(new Paragraph({
        children: [new TextRun({ text: params.title, bold: true, size: 36 })],
        alignment: 'center',
      }))
      children.push(new Paragraph({ children: [new TextRun('')] }))
    }

    const blocks = Array.isArray(params.content) ? params.content : []
    for (const raw of blocks) {
      const block = raw ?? {}
      if (block.type === 'table') {
        const headers = block.headers || []
        const rows = block.rows || []
        if (headers.length === 0 && rows.length === 0) continue
        const allRows = headers.length > 0 ? [headers, ...rows] : rows
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: allRows.map(row => new TableRow({
            children: (Array.isArray(row) ? row : []).map(cell => new TableCell({
              children: [new Paragraph({ children: [new TextRun(toCellText(cell))] })],
            })),
          })),
        }))
      } else if (block.type === 'list') {
        const items = Array.isArray(block.items) ? block.items : []
        for (const item of items) {
          children.push(new Paragraph({
            children: [new TextRun(toCellText(item))],
            bullet: { level: 0 },
          }))
        }
      } else {
        const text = block.text ?? ''
        let paragraph
        switch (block.type) {
          case 'heading':
          case 'h1':
            paragraph = new Paragraph({ children: [new TextRun(text)], heading: HeadingLevel.HEADING_1 })
            break
          case 'h2':
            paragraph = new Paragraph({ children: [new TextRun(text)], heading: HeadingLevel.HEADING_2 })
            break
          case 'h3':
            paragraph = new Paragraph({ children: [new TextRun(text)], heading: HeadingLevel.HEADING_3 })
            break
          case 'code':
            paragraph = new Paragraph({ children: [new TextRun({ text, font: 'Courier New' })] })
            break
          default:
            paragraph = new Paragraph({ children: [new TextRun(text)] })
        }
        children.push(paragraph)
      }
    }

    const doc = new Document({ sections: [{ children }] })
    const buf = await Packer.toBuffer(doc)
    writeFileSync(dest, buf)
    return {
      content: `📄 DOCX: Generated "${basename(dest)}" with ${children.length} block(s)\n   File: ${dest}`,
      rawPath: dest,
    }
  } catch (err) {
    return { content: `DOCX generation failed: ${err.message}`, isError: true }
  }
}

// ── docx_read ───────────────────────────────────────────────────

async function docxRead(params) {
  const fp = params?.file_path
  if (!fp) return { content: 'Error: file_path is required', isError: true }
  if (!existsSync(fp)) return { content: `Error: file not found: ${fp}`, isError: true }

  try {
    const mammoth = (await import('mammoth')).default
    const result = await mammoth.extractRawText({ path: fp })
    const text = result.value ?? ''
    if (!text.trim()) return { content: 'DOCX appears to contain no extractable text.' }
    const truncated = text.length > 8000
      ? text.slice(0, 8000) + `\n\n... (truncated, ${text.length - 8000} more chars.)`
      : text
    return { content: truncated, rawPath: fp }
  } catch (err) {
    return { content: `DOCX read failed: ${err.message}`, isError: true }
  }
}

// ── Tool exports ───────────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'docx_create',
      description: 'Generate a real .docx Word document from content blocks: {type:"heading"|"h2"|"h3"|"paragraph"|"table"|"code"|"list", text?, headers?, rows?, items?}. Optional title renders as a centered bold heading.',
      input_schema: {
        type: 'object',
        properties: {
          destination_path: { type: 'string', description: 'Output .docx file path' },
          title: { type: 'string', description: 'Document title (centered, bold)' },
          content: {
            type: 'array',
            description: 'Content blocks: [{type, text?, headers?, rows?, items?}]',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['heading', 'h2', 'h3', 'paragraph', 'table', 'code', 'list'] },
                text: { type: 'string' },
                headers: { type: 'array' },
                rows: { type: 'array' },
                items: { type: 'array' },
              },
            },
          },
        },
        required: ['destination_path', 'content'],
      },
    },
    execute: async (params) => docxCreate(params),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'docx_read',
      description: 'Extract plain text from a .docx Word document for reading into context. Large documents are truncated at 8000 characters.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .docx file to read' },
        },
        required: ['file_path'],
      },
    },
    execute: async (params) => docxRead(params),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
