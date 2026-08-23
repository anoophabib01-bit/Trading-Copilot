// Two-Chat Split Layout — durable record (dynamic plugin spl-3/pkg-3)
// CLIENT half (code.client for cordis_define): registers a "Split" view tab.
const CLIENT = `return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return
    function extractText(node) {
      if (!node) return ''
      const blocks = (node.kind === 'assistant') ? (node.blocks || []) : (node.content || [])
      const parts = []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'text') { if (b.text) parts.push(b.text) }
        else if (b.type === 'image') parts.push('[image]')
        else if (b.type === 'reasoning') parts.push('[reasoning]')
        else parts.push('[block]')
      }
      return parts.join('\\n')
    }
    const paneStyle = { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, overflow: 'hidden', borderRight: '1px solid rgba(128,128,128,0.25)' }
    const headerStyle = { padding: '6px 10px', fontWeight: 600, fontSize: '12px', borderBottom: '1px solid rgba(128,128,128,0.2)', flex: '0 0 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
    const scrollerStyle = { flex: '1 1 auto', overflowY: 'auto', padding: '8px' }
    const msgStyle = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', lineHeight: 1.45, marginBottom: '8px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)' }
    const composerStyle = { flex: '0 0 auto', padding: '6px 8px', borderTop: '1px solid rgba(128,128,128,0.2)', display: 'flex', gap: '6px', alignItems: 'center' }
    const taStyle = { flex: '1 1 auto', resize: 'none', minHeight: '34px', fontFamily: 'inherit', fontSize: '13px' }
    function Pane({ title, nodes, onSend }) {
      const [draft, setDraft] = React.useState('')
      const items = nodes.map((n, i) => React.createElement('div', { key: i, style: msgStyle }, extractText(n) || (n.kind ? n.kind : '')))
      return React.createElement('div', { style: paneStyle },
        React.createElement('div', { style: headerStyle, title }, title),
        React.createElement('div', { style: scrollerStyle }, ...items),
        React.createElement('div', { style: composerStyle },
          React.createElement('textarea', { value: draft, placeholder: 'Message…', style: taStyle, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.trim()) { onSend(draft.trim()); setDraft('') } } } }),
          React.createElement('button', { disabled: !draft.trim(), onClick: () => { onSend(draft.trim()); setDraft('') }, style: { cursor: 'pointer' } }, 'Send')
        )
      )
    }
    slots.inject('conversation.view', () => slots.register(
      { name: 'conversation.view', id: 'split', order: 20, label: 'Split' },
      (props) => {
        const useSession = props.useSession
        const useSessions = props.useSessions
        const snapshot = useSession ? useSession() : null
        const sessionsList = useSessions ? useSessions() : null
        const currentId = props.sessionId
        const sessionsSvc = ctx.get('sessions')
        const leftNodes = snapshot ? (snapshot.nodes || []) : []
        const ids = (sessionsList && sessionsList.ids) ? sessionsList.ids : []
        const candidateIds = ids.filter(id => id !== currentId)
        const [secondId, setSecondId] = React.useState(candidateIds.length ? candidateIds[0] : null)
        React.useEffect(() => { if (secondId === null && candidateIds.length) setSecondId(candidateIds[0]) }, [candidateIds[0], currentId])
        const secondSession = (secondId && sessionsSvc) ? sessionsSvc.binding(secondId)?.session : undefined
        const [rightSnap, setRightSnap] = React.useState(null)
        React.useEffect(() => {
          if (!secondSession) { setRightSnap(null); return undefined }
          setRightSnap(secondSession.getSnapshot())
          return secondSession.subscribe(() => setRightSnap(secondSession.getSnapshot()))
        }, [secondSession])
        const rightNodes = rightSnap ? (rightSnap.nodes || []) : []
        const [collapsed, setCollapsed] = React.useState(false)
        const [dragging, setDragging] = React.useState(false)
        const [leftPct, setLeftPct] = React.useState(50)
        const sendTo = (id, text) => {
          const s = sessionsSvc && id ? sessionsSvc.binding(id)?.session : undefined
          if (s && text.trim()) s.prompt([{ type: 'text', text: text.trim() }], 'queue')
        }
        const nameOf = (id) => { const r = sessionsList && sessionsList.byId[id]; return r ? (r.title || id) : id }
        const leftTitle = nameOf(currentId)
        const rightTitle = secondId ? nameOf(secondId) : 'Second chat'
        const containerStyle = { display: 'flex', height: '100%', width: '100%', position: 'relative', cursor: dragging ? 'col-resize' : 'default' }
        return React.createElement('div', { style: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column' } },
          React.createElement('div', { style: { flex: '0 0 auto', display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)' } },
            React.createElement('span', { style: { fontSize: '12px', fontWeight: 600 } }, 'Split chat'),
            React.createElement('select', { value: secondId || '', onChange: (e) => setSecondId(e.target.value || null), style: { fontSize: '12px' } },
              candidateIds.map(id => React.createElement('option', { key: id, value: id }, nameOf(id)))
            ),
            React.createElement('button', { onClick: () => setCollapsed(!collapsed), style: { fontSize: '12px', cursor: 'pointer' } }, collapsed ? '⇤ Split' : '⇥ One')
          ),
          React.createElement('div', {
            style: containerStyle,
            onMouseMove: (e) => { if (dragging) { const r = e.currentTarget.getBoundingClientRect(); if (r.width > 0) { const pct = Math.min(85, Math.max(15, ((e.clientX - r.left) / r.width) * 100)); setLeftPct(pct) } } },
            onMouseUp: () => setDragging(false),
            onMouseLeave: () => setDragging(false)
          },
            React.createElement('div', { style: { ...paneStyle, width: collapsed ? '100%' : (leftPct + '%') } },
              React.createElement(Pane, { title: leftTitle, nodes: leftNodes, onSend: (t) => sendTo(currentId, t) })
            ),
            collapsed ? null : React.createElement('div', { onMouseDown: (e) => { e.preventDefault(); setDragging(true) }, style: { width: '6px', cursor: 'col-resize', flex: '0 0 auto', background: 'rgba(128,128,128,0.18)' } }),
            collapsed ? null : React.createElement('div', { style: { ...paneStyle, borderRight: 'none', width: ((100 - leftPct) + '%') } },
              React.createElement(Pane, { title: rightTitle, nodes: rightNodes, onSend: (t) => sendTo(secondId, t) })
            )
          )
        )
      }
    ))
  }
}`;
module.exports = { id: 'spl-3', name: 'Two-Chat Split Layout', CLIENT }
