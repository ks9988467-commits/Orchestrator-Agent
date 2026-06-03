# Tasks

## 🧪 待测试清单（下一阶段集中跑）

### LLM Provider 连通性
- [x] LLM配置页 → Anthropic「测试」按钮 → ✓ 连接正常
- [x] LLM配置页 → OpenRouter「测试」按钮 → ✓ 连接正常
- [ ] LLM配置页 → OpenAI「测试」按钮（可选）
- [ ] LLM配置页 → Google「测试」按钮（可选）

### Agent 对话
- [x] Chat Agent — 发一条普通消息，验证有回复
- [ ] CRM Agent — 问「最近有哪些新线索」，验证能查 leads 表
- [ ] Account Agent — 问「上个月花费多少」，验证能查 analytics_daily 表
- [ ] Code Agent — 问「写一个 Python hello world」，验证有代码输出
- [ ] Hermes 路由 — Chat 页发「帮我查客户数据」，验证自动委托 CRM Agent

### 数据工具（uses_tools 动态化）
- [ ] Agent管理 → 任选一个新 Agent → 打开「数据工具」toggle → 保存 → 测试该 Agent 能否查数据

### RAG 知识库
- [ ] 知识库页 → 新建知识库 → 录入一段文字 → 搜索关键词 → 验证返回结果
- [ ] Agent 对话中问相关问题 → 验证 Agent 会调用 search_knowledge_base 工具

### 预警规则
- [ ] 数据页 → 预警标签 → 新建规则（填名称/指标/阈值）→ 验证规则出现在列表
- [ ] 删除该规则 → 验证从列表消失

### 文件审批
- [ ] 上传一个文件 → Tag 审批人 → 审批人收到通知（WhatsApp 或 Email）
- [ ] 审批人登录 → 批准 / 拒绝 → 状态更新

### 集成（需真实凭证）
- [ ] WhatsApp — 集成页保存凭证 → 点「测试」→ 收到测试消息
- [ ] Email SMTP — 集成页保存凭证 → 点「测试」→ 收到测试邮件

---

## Up Next（代码还没写）
- [ ] UGC Studio 4 个标签页（脚本工坊 / 封面套件 / 社群贴文 / 完整预览）— 后端已就绪，纯前端

## Done
- [x] 项目基础架构（Supabase 表结构、Edge Function、Cloudflare Worker）
- [x] Dashboard UI — 完整多页面单文件应用
- [x] Agent 管理（增删改、LLM 分配、启用/禁用、版本历史）
- [x] LLM 提供商配置（Anthropic / OpenAI / Google / OpenRouter 多路自动降级）
- [x] 对话流（Chat，SSE 流式输出）
- [x] Hermes 路由 + 委托机制 + soul.md 行为规范
- [x] 自学习（agent_skills 路由规则、user_prefs 偏好提取）
- [x] 工作流调度（定时触发、节点串联）
- [x] 缺口问题页（agent_suggestions 收集 + Hermes 分析）
- [x] 缺口问题 → 一键建 Agent（Hermes 生成配置，用户确认后写入 DB）
- [x] Web Search（OpenRouter + Perplexity Sonar 实时搜索）
- [x] Agent 测试面板 Auth 修复（401 → 正常响应）
- [x] 数据页 — Leads / 广告报告导入导出（Excel .xlsx，SheetJS）
- [x] Leads RLS 修复（INSERT / UPDATE policy）
- [x] UC PTM 数据导入（27,725 条电话号码）
- [x] 文件审批流程（上传 / Tag 审批人 / 批准拒绝 / 状态追踪）
- [x] 员工管理、消息中心、任务管理、UGC Studio
- [x] 多租户架构（OTP 登录、tenant_id 隔离）
- [x] 项目整理（删除垃圾文件，清理 dashboard 死代码 616 行）
- [x] 数据页 Analytics 标签页 — loadAnalytics + Chart.js（花费/CPL/CTR）+ 马来西亚行业基准线
- [x] RAG 知识库 UI — 新建/删除知识库、录入文档（kb_ingest）、语义搜索（kb_search）
- [x] RAG 全链路打通 — RLS策略补建、embedding格式修复、tenant隔离、Agent工具 search_knowledge_base
- [x] 预警标签页 switchDataTab 修复 + loadAlertHistory/loadAlertRules 实现
- [x] 文件审批权限隔离 — documents 加 tenant_id、session 存 email、Member 只看自己文件、审批按钮只对当前审批人可见、删除按钮只对上传者/admin/master 可见
- [x] Chat 多文件上传 — input 支持 multiple、并行上传、files[] 数组传 edge function、Anthropic 多文档联合分析
- [x] WhatsApp / Telegram / SendGrid / Email SMTP 集成测试按钮
- [x] LLM Provider 测试按钮（Anthropic / OpenAI / Google / OpenRouter）
- [x] DATA_AGENTS 动态化 — agents 表加 uses_tools 列，Dashboard toggle 控制
- [x] 预警规则 CRUD — list / save / delete 全链路
- [x] Alert / knowledge_bases / kb_chunks / alert_rules RLS 策略
