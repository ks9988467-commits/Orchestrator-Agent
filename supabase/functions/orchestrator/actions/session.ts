// Login (OTP), session and client (tenant) management actions.
import { SESSION_TTL_MS, constantTimeEqual, masterEmailList, randomToken, sha256Hex } from '../auth.ts'
import { sendSmtpMail } from '../automation.ts'
import { dbGet, dbInsert, dbInsertReturning, dbPatch, dbPatchWhere, dbUpsert } from '../db.ts'
import { type Body, R } from '../state.ts'

// Returns the response for one of this module's actions, or undefined for any other action
export async function handleSessionActions(body: Body, CORS: Record<string, string>): Promise<Response | undefined> {
  // ── Session: who am I / logout ───────────────────────────────────
  if (body.action === 'whoami') {
    const tRows = R.tenantId ? await dbGet('tenants', 'name', { id: `eq.${R.tenantId}` }, undefined, 1) : []
    return new Response(JSON.stringify({ ok: true, email: R.email, role: R.role, tenant_id: R.tenantId, tenant_name: tRows[0]?.name ?? '' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'logout') {
    if (R.authHash) await dbPatchWhere('sessions', { token_hash: `eq.${R.authHash}` }, { revoked_at: new Date().toISOString() })
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // \u2500\u2500 OTP: send \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (body.action === 'send_otp') {
    const email = String(body.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ error: 'valid email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    // Only emails that can log in get a code. The response is the same either way, so
    // this cannot be used to find out which emails are registered.
    const canLogIn = masterEmailList().includes(email) || (await dbGet('tenant_users', 'id', { email: `eq.${email}` }, undefined, 1)).length > 0
    if (!canLogIn) return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    // Rate limit per email: one code a minute, five an hour
    const hourAgo = new Date(Date.now() - 3600_000).toISOString()
    const recent = await dbGet('otp_requests', 'created_at', { email: `eq.${email}`, created_at: `gte.${hourAgo}` }, 'created_at.desc', 5) as { created_at: string }[]
    if (recent.length >= 5 || (recent[0] && Date.now() - Date.parse(recent[0].created_at) < 60_000)) {
      return new Response(JSON.stringify({ error: '请求太频繁，请稍后再试' }), { status: 429, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
    // Only a hash of the code is stored
    await dbInsert('otp_requests', { email, code: await sha256Hex(`${email}:${code}`) })
    if (Deno.env.get('OTP_DEV_ECHO') === 'true') {
      // Local development only: print the code and hand it back to the login page instead of emailing it
      console.log(`[OTP_DEV_ECHO] ${email}: ${code}`)
      return new Response(JSON.stringify({ ok: true, dev_code: code }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    // Send email via Gmail SMTP using fetch to SMTP2Go-like approach \u2014 use denomailer
    try {
      await sendSmtpMail({ host: 'smtp.gmail.com', port: 465, username: 'ks9988467@gmail.com', password: Deno.env.get('GMAIL_APP_PWD') ?? '' }, {
        from: 'Orchestrator Agent <ks9988467@gmail.com>',
        to: email,
        subject: `\u9A8C\u8BC1\u7801\uFF1A${code}`,
        content: `\u60A8\u7684 Orchestrator Agent \u9A8C\u8BC1\u7801\u662F\uFF1A\n\n${code}\n\n10 \u5206\u949F\u5185\u6709\u6548\uFF0C\u8BF7\u52FF\u5206\u4EAB\u7ED9\u4ED6\u4EBA\u3002`,
      })
    } catch(e) {
      return new Response(JSON.stringify({ error: `\u53D1\u9001\u5931\u8D25\uFF1A${(e as Error).message}` }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // \u2500\u2500 OTP: verify \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (body.action === 'verify_otp') {
    const email = String(body.email || '').trim().toLowerCase()
    const code = String(body.code || '').trim()
    if (!email || !code) return new Response(JSON.stringify({ error: 'email and code required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    // Only the newest unused, unexpired code for this email counts
    const rows = await dbGet('otp_requests', 'id,code,attempts', {
      email: `eq.${email}`, used: 'eq.false', expires_at: `gte.${new Date().toISOString()}`,
    }, 'id.desc', 1) as { id: number; code: string; attempts: number }[]
    if (!rows.length) return new Response(JSON.stringify({ ok: false, error: '\u9A8C\u8BC1\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const otp = rows[0]
    if (!constantTimeEqual(otp.code, await sha256Hex(`${email}:${code}`))) {
      // Five wrong guesses use the code up
      const attempts = (otp.attempts || 0) + 1
      await dbPatch('otp_requests', String(otp.id), attempts >= 5 ? { attempts, used: true } : { attempts })
      return new Response(JSON.stringify({ ok: false, error: attempts >= 5 ? '\u9519\u8BEF\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u91CD\u65B0\u83B7\u53D6\u9A8C\u8BC1\u7801' : '\u9A8C\u8BC1\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    await dbPatch('otp_requests', String(otp.id), { used: true })
    // Master = an email listed in MASTER_EMAILS (comma-separated). Everyone else needs a
    // tenant_users row — an unknown email is refused, never treated as master.
    const isMasterEmail = masterEmailList().includes(email)
    const tuRows = await dbGet('tenant_users', 'tenant_id,role', { email: `eq.${email}` })
    let tenantId: string|null = tuRows[0]?.tenant_id ?? null
    let role: string = tuRows[0]?.role === 'admin' ? 'admin' : 'member'
    let tenantName = ''
    if (isMasterEmail) {
      role = 'master'
      const masterRows = await dbGet('tenants', 'id,name', { name: 'eq.Master' })
      if (masterRows.length) { tenantId = masterRows[0].id; tenantName = masterRows[0].name }
    } else if (!tuRows.length) {
      return new Response(JSON.stringify({ ok: false, error: '该邮箱没有访问权限，请联系管理员' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    } else if (tenantId) {
      const tRows = await dbGet('tenants', 'name', { id: `eq.${tenantId}` })
      tenantName = tRows[0]?.name ?? ''
    }
    // Issue a session: the token goes to the browser once, only its hash is kept
    const token = randomToken()
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
    const sIns = await dbInsert('sessions', { token_hash: await sha256Hex(token), email, tenant_id: tenantId, role, expires_at: expiresAt })
    if (!sIns.ok) return new Response(JSON.stringify({ ok: false, error: '登录失败，请重试' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ ok: true, token, expires_at: expiresAt, tenant_id: tenantId, role, tenant_name: tenantName, email }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // \u2500\u2500 Tenant management (master only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (body.action === 'list_tenants') {
    // Master check (R.isMaster comes from the authenticated session)
    if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const tenants = await dbGet('tenants', 'id,name,slug,contact_name,contact_email,active,created_at', {}, 'created_at.asc')
    const result = await Promise.all((tenants as Record<string,unknown>[]).map(async t => {
      const tid = String(t.id)
      const [spendRows, leadRows] = await Promise.all([
        dbGet('ad_reports', 'amount_spent_myr', { tenant_id: `eq.${tid}` }, undefined, 1000),
        dbGet('leads', 'id', { tenant_id: `eq.${tid}` }, undefined, 1),
      ])
      const totalSpend = (spendRows as {amount_spent_myr:number}[]).reduce((s,r) => s + (Number(r.amount_spent_myr)||0), 0)
      return { ...t, total_spend: +totalSpend.toFixed(2), lead_count: (leadRows as unknown[]).length }
    }))
    return new Response(JSON.stringify({ ok: true, tenants: result }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'get_master_summary') {
    if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const tenants = await dbGet('tenants', 'id,name,slug,active')
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10)
    const summary = await Promise.all((tenants as Record<string,unknown>[]).filter(t => t.active).map(async t => {
      const tid = String(t.id)
      const [analRows, leadRows, alertRows] = await Promise.all([
        dbGet('analytics_daily', 'spend_myr,new_contacts', { tenant_id: `eq.${tid}`, date: `gte.${monthStart}` }, undefined, 1000),
        dbGet('leads', 'id', { tenant_id: `eq.${tid}`, date: `gte.${monthStart}` }, undefined, 500),
        dbGet('automation_logs', 'id', { tenant_id: `eq.${tid}`, read: 'eq.false' }, 'triggered_at.desc', 10),
      ])
      let spend = 0, contacts = 0
      for (const r of analRows as Record<string,number>[]) { spend += Number(r.spend_myr)||0; contacts += Number(r.new_contacts)||0 }
      return { id: tid, name: t.name, slug: t.slug, month_spend: +spend.toFixed(2), month_leads: (leadRows as unknown[]).length, month_contacts: contacts, cpl: contacts > 0 ? +(spend/contacts).toFixed(2) : null, alerts: (alertRows as unknown[]).length }
    }))
    return new Response(JSON.stringify({ ok: true, summary }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Tenant management actions (master only) ─────────────────────
  if (body.action === 'create_tenant') {
    if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const { name, contact_name, contact_email } = body
    if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const row = await dbInsertReturning('tenants', { name, contact_name: contact_name||null, contact_email: contact_email||null, active: true })
    return new Response(JSON.stringify({ ok: true, tenant: row }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'update_tenant') {
    if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const { tenant_id, active, name, contact_name, contact_email } = body
    if (!tenant_id) return new Response(JSON.stringify({ error: 'tenant_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const patch: Record<string,unknown> = {}
    if (active !== undefined) patch.active = active
    if (name !== undefined) patch.name = name
    if (contact_name !== undefined) patch.contact_name = contact_name
    if (contact_email !== undefined) patch.contact_email = contact_email
    await dbPatch('tenants', tenant_id as string, patch)
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'add_tenant_user') {
    if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    // The new user's role is `user_role`: `role` is the caller's own session role.
    // master is granted only through MASTER_EMAILS, never stored here.
    const tenant_id = body.tenant_id
    const email = String(body.email || '').trim().toLowerCase()   // login lookups are lower-case
    const userRole = String(body.user_role || 'member')
    if (!tenant_id || !email) return new Response(JSON.stringify({ error: 'tenant_id and email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    if (!['admin', 'member'].includes(userRole)) return new Response(JSON.stringify({ error: 'user_role must be admin or member' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    await dbUpsert('tenant_users', { tenant_id, email, role: userRole }, 'email,tenant_id')
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
}
