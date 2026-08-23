// Image & File Attach — durable record (dynamic plugin att-2/pkg-2)
// HOST half (code.host for cordis_define):
const HOST = `return {
  inject: ['fs'],
  apply(ctx) {
    harness.handle('attach.save', async (args) => {
      const base64 = String((args && args.base64) || '')
      if (!base64) return { ok: false, error: 'no data' }
      const rawName = String((args && args.name) || 'file')
      const name = rawName.replace(/[\\\\/:*?"<>|\\r\\n]/g, '_').slice(0, 60) || 'file'
      const abs = 'G:\\\\MNQ-CoPilot\\\\DATA\\\\chat-attachments-' + Date.now() + '-' + name + '.b64'
      try {
        const target = await ctx.fs.resolve(abs)
        await ctx.fs.writeText(target, base64)
        return { ok: true, path: abs, name: rawName }
      } catch (e) {
        return { ok: false, error: (e && e.message) ? e.message : String(e) }
      }
    })
  }
}`;
// CLIENT half (code.client): paperclip in conversation.input.left + Ctrl+V paste.
const CLIENT = `return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return
    function bytesToBase64(bytes) {
      const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      let out = '', i = 0
      for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
        out += C[(n >> 18) & 63] + C[(n >> 12) & 63] + C[(n >> 6) & 63] + C[n & 63]
      }
      const rem = bytes.length - i
      if (rem === 1) { const n = bytes[i] << 16; out += C[(n >> 18) & 63] + C[(n >> 12) & 63] + '==' }
      else if (rem === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += C[(n >> 18) & 63] + C[(n >> 12) & 63] + C[(n >> 6) & 63] + '=' }
      return out
    }
    async function saveFile(file) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const base64 = bytesToBase64(bytes)
        const res = await host.call('attach.save', { name: file.name, mime: file.type, base64 })
        return (res && res.ok) ? res : null
      } catch (e) { console.error('attach save failed', e); return null }
    }
    let actionsRef = null
    if (typeof document !== 'undefined') {
      ctx.effect(() => {
        const onPaste = (e) => {
          const conv = ctx.get('conversation')
          if (!conv || !e.clipboardData || !e.clipboardData.items) return
          const files = []
          for (let i = 0; i < e.clipboardData.items.length; i++) {
            const it = e.clipboardData.items[i]
            if (it.kind === 'file' && it.type && /^image\\//.test(it.type)) {
              const f = it.getAsFile()
              if (f) files.push(f)
            }
          }
          if (!files.length) return
          e.preventDefault()
          try {
            const atts = conv.createDraftImages(files)
            if (actionsRef && actionsRef.addImages) actionsRef.addImages(atts.map(a => a.id))
          } catch (err) { console.error('attach paste failed', err) }
        }
        document.addEventListener('paste', onPaste, true)
        return () => document.removeEventListener('paste', onPaste, true)
      }, 'attach paste listener')
    }
    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'att-picker', order: 20 },
      (props) => {
        actionsRef = props.inputActions
        const conv = ctx.get('conversation')
        const onFiles = (files) => {
          if (!files || !files.length) return
          const img = []; const other = []
          for (const f of files) {
            if (f && /^image\\/(png|jpeg|webp|gif)$/i.test(f.type)) img.push(f)
            else other.push(f)
          }
          if (img.length && conv) {
            try {
              const atts = conv.createDraftImages(img)
              const acts = props.inputActions
              if (acts && acts.addImages) acts.addImages(atts.map(a => a.id))
            } catch (e) { console.error('attach image failed', e) }
          }
          for (const f of other) {
            saveFile(f).then((res) => {
              if (res) {
                const draft = (props.input && props.input.draft) ? props.input.draft : ''
                const note = draft + (draft ? '\\n' : '') + '[📎 attached file: ' + f.name + ' — saved at ' + res.path + ' (base64). Please read and decode this file.]'
                if (props.inputActions && props.inputActions.setDraft) props.inputActions.setDraft(note)
              }
            })
          }
        }
        return React.createElement(
          'label',
          { title: 'Attach image / file (or Ctrl+V)', style: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer', padding: '2px 4px', fontSize: '16px', lineHeight: 1 } },
          '📎',
          React.createElement('input', {
            type: 'file', multiple: true,
            accept: 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain',
            style: { display: 'none' },
            onChange: (e) => { onFiles(Array.from(e.target.files || [])); e.target.value = '' }
          })
        )
      }
    ))
  }
}`;
module.exports = { id: 'att-2', name: 'Image & File Attach', HOST, CLIENT }
