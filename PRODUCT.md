# Product

## Register

product

## Users
马来西亚清洁服务企业的运营与市场团队（中文使用者）。日常在办公室盯数据、调 AI agent、看每日摘要、跟进线索、查广告成效、生成内容。技术水平中等，要的是「一个台子搞定运营」，不是学一套新工具。

## Product Purpose
Orchestrator Agent — 跑在 Supabase 上的多 Agent AI 运营中枢。把 CRM 线索、Facebook 广告分析、AI 助手对话、自动化预警、UGC 内容生成、获客成本分析、文件审批统一在一个 dashboard 里。目标：让小团队用 AI 放大运营能力，把分散在多个平台的运营动作收口到一处。成功 = 团队每天第一个打开它、靠它做决策。

## Brand Personality
自信、鲜明、高效。三词：**Bold**（品牌红黄鲜明，有识别度）、**Sharp**（专业利落，不拖泥带水）、**Efficient**（工具优先，信息密集但有序）。语气直接、不啰嗦、不用营销腔。

## Anti-references
- **花哨的 SaaS 营销页**：渐变背景、超大标题、装饰性动画、无意义卡片堆砌、hero-metric 模板。这是工具，不是落地页。
- **老旧后台管理系统**：Bootstrap 默认样式、拥挤的灰色表格、零留白、毫无设计感、状态全靠刷新。

## Design Principles
1. **品牌鲜明，集中施力** — 红 (#da0d15) / 黄 (#ffd405) 是高能量色，集中用在主操作、选中态、状态指示、KPI 数字、空状态这些「该被看见」的位置；工作表面（表格、表单、面板）保持干净中性。Bold where it counts, calm everywhere else。
2. **工具消失于任务** — earned familiarity（参照 Linear/Notion/Stripe）。用标准导航、表格、表单，不发明奇怪控件，不为风格牺牲可用性。
3. **密度有节奏** — 运营台需要信息密度，但用统一间距和清晰层级制造呼吸感，密集 ≠ 拥挤。
4. **高对比、可达** — 无障碍重点优化。正文 ≥WCAG AA (4.5:1)；黄色只做背景配黑字，绝不在浅底上做文字色；状态不只靠颜色（配图标/文字）。
5. **状态完整** — 每个交互组件都有 hover/focus/active/disabled/loading/empty。空状态教用户怎么用，不是「暂无数据」了事。

## Accessibility & Inclusion
WCAG **AA** 为底线（用户明确要求重点优化）。正文对比 ≥4.5:1，大字/粗体 ≥3:1，placeholder 同样 ≥4.5:1。Cyber Yellow #ffd405 仅作背景色（配黑字），永不作浅色背景上的前景文字。键盘全程可达 + `:focus-visible` 焦点环（已实现，红色 2px）。尊重 `prefers-reduced-motion`（动效降级为淡入/瞬切）。色弱友好：成功/警告/错误等状态除颜色外附带图标或文字。
