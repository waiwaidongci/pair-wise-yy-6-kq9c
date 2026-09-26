# 墨锭试磨室

运行：

```bash
npm start
```

访问`http://localhost:3037`。数据保存在`data/ink-stick-testing.json`。

## 续磨链

同一块砚上的多次研墨不再各自为零：每段续磨记录**砚台、研墨分钟、残墨量（克）、研磨人**，段与段沿 `prevId` 接成链。

- 新段自动接在同砚**未结算**的前一段后面，前段随之结算；同砚同时只挂一段未结算。
- 单砚**累计研墨超过 40 分钟**或**最新残墨少于 2 克**时，接口和页面都会提示换砚。
- 改正前段数据后，挂在它后面的段先**停用**，被改正的段重新成为未结算的链尾，续磨从这里继续。
- 职责拆分：`lib/grind-chain.js` 负责续磨判定（纯逻辑），`lib/store.js` 负责记录存放，页面里的续磨链卡片操作独立成区。
- 旧试磨记录不受影响，可通过 `GET /api/items/:id` 或卡片上的"试磨详情"单独查看。

接口：

- `GET /api/chains` 各砚续磨链汇总（累计分钟、最新残墨、换砚提示、已停用段）
- `GET /api/segments` 全部段记录
- `POST /api/segments` 追加一段 `{ inkstone, minutes, residualInk, grinder }`
- `PATCH /api/segments/:id` 改正前段 `{ minutes, residualInk, grinder }`，后续段停用
- `GET /api/items/:id` 单独查看一条墨锭的旧试磨记录
