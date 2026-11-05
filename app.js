/* ================================================================
   教师工作平台 · 应用逻辑
   纯前端演示实现：localStorage 持久化，四角色，数据为虚构样例
================================================================ */
"use strict";

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s??"").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const todayStr = () => new Date().toISOString().slice(0,10);
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

function toast(msg, err){
  const t = document.createElement("div");
  t.className = "toast" + (err?" err":"");
  t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(()=>t.remove(), 2600);
}
function modal(title, bodyHTML, buttons){
  const root = $("#modal-root");
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  const btns = (buttons||[{text:"确定",cls:"btn-primary",fn:null}]);
  mask.innerHTML = `<div class="modal"><div class="modal-head">${esc(title)}<span class="x">✕</span></div>
    <div class="modal-body">${bodyHTML}</div>
    <div class="modal-foot">${btns.map((b,i)=>`<button class="btn ${b.cls||""}" data-mi="${i}">${esc(b.text)}</button>`).join("")}</div></div>`;
  root.appendChild(mask);
  const close = ()=>mask.remove();
  mask.querySelector(".x").onclick = close;
  mask.addEventListener("click", e=>{ if(e.target===mask) close(); });
  btns.forEach((b,i)=>{ mask.querySelector(`[data-mi="${i}"]`).onclick = ()=>{ if(b.fn){ if(b.fn(mask)===false) return; } close(); }; });
  return {close, el:mask};
}
function confirmBox(text, onOk){
  modal("二次确认", `<p>${esc(text)}</p><p class="muted" style="margin-top:8px">该操作属高风险操作，已记录审计日志。</p>`,
    [{text:"取消"},{text:"确认执行",cls:"btn-danger",fn:onOk}]);
}
function download(filename, content, mime){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], {type:(mime||"text/plain")+";charset=utf-8"}));
  a.download = filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 3000);
}
const exportCSV = (name, headers, rows) => {
  const csv = "\uFEFF" + [headers.join(","), ...rows.map(r=>r.map(c=>`"${String(c??"").replace(/"/g,'""')}"`).join(","))].join("\n");
  download(name+".csv", csv, "text/csv");
  toast("已导出 "+name+".csv");
};
const exportWord = (name, inner) => {
  const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(name)}</title></head><body style="font-family:'Microsoft YaHei';font-size:13px">${inner}</body></html>`;
  download(name+".doc", html, "application/msword");
  toast("已导出 "+name+".doc");
};

/* ---------- 状态与持久化 ---------- */
const LS_KEY = "twb_state_v2";
const HAD_LOCAL_DATA = (()=>{ try{ return !!localStorage.getItem(LS_KEY); }catch(e){ return false; } })();
let state;
function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){ state = JSON.parse(raw); }
    else { state = JSON.parse(JSON.stringify(SEED)); state.attHT = {}; }
  }catch(e){ state = JSON.parse(JSON.stringify(SEED)); state.attHT = {}; }
  // 迁移：班级体系 / 教师密码 / 作业
  if(!Array.isArray(state.classes) || !state.classes.length){
    state.classes = [{id:uid("C"), name:(state.tenant&&state.tenant.clsName)||"我的班级", headteacher:""}];
  }
  (state.users||[]).forEach(u=>{ if(!u.password) u.password = "123456"; });
  if(!Array.isArray(state.homework)) state.homework = [];
  if(!Array.isArray(state.hws)) state.hws = [];
  if(!Array.isArray(state.hwSessions)) state.hwSessions = [];   // 作业完成记录（多次汇入）
  if(!Array.isArray(state.examSheets)) state.examSheets = [];   // 考试成绩单（v37，多次导入）
  /* 旧版单快照作业记录 → 迁移为一条已入表记录，避免数据丢失 */
  if(state.homeworkRec && !state.__hwMigrated){
    Object.keys(state.homeworkRec).forEach(cls=>{
      const r = state.homeworkRec[cls];
      if(r && (r.files||[]).length)
        state.hwSessions.push({id:uid("HW"), cls, date:todayStr(), period:(state.periods&&state.periods[1])||"第1节",
          subject:"已导入记录", folder:r.folder||"", files:r.files, ignored:r.ignored||{}, manual:r.manual||{}, savedAt:Date.now()});
    });
    state.__hwMigrated = 1;
  }
  /* v33 全新 UI：一次性切回浅色米色主题（用户可随时点「深浅」切回） */
  if(!state.settings || state.settings.__uiV33 !== 2){
    if(!state.settings) state.settings = {wecom:"未连接", sideW:232};
    state.settings.dark = false; state.settings.__uiV33 = 2;
  }
  if(!state.seating) state.seating = {rows:5, cols:6, cells:Array(30).fill(null)};
  if(!state.attHT) state.attHT = {};
  if(!state.settings) state.settings = {wecom:"未连接", dark:true, sideW:232};
  if(typeof migrateNotes==="function") migrateNotes();
  save();
}
function save(){
  /* 时间戳单调不减：防止云端来自"时钟略快设备"的数据在本机反复触发 拉取→重载 循环 */
  state.__savedAt = Math.max(Date.now(), state.__savedAt || 0);
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  scheduleCloudPush();
}

/* ---------- 云端同步（PostgREST / Supabase 兼容） ---------- */
const CLOUD_TABLE = "twb_cloud";
let bootDone = false, cloudBusy = false, cloudPending = false, cloudTimer = null, cloudApplying = false;
let cloudState = {status:"off", msg:""};
function cloudConf(){ return (state.settings && state.settings.cloud) || {}; }
function cloudOn(){ const c = cloudConf(); return !!(c.url && c.key); }
/* 本机是否有"真实数据"（学生 / 教师账号 / 笔记 / 考勤）——用于防止空数据覆盖云端 */
function hasMeaningfulData(){
  return !!(state.students||[]).length || !!(state.users||[]).length || !!(state.notes||[]).length || Object.keys(state.rollcall||{}).length>0;
}
function cloudBase(){
  let u = String(cloudConf().url||"").trim().replace(/\/+$/,"").replace(/\/rest\/v1$/,"");
  if(!u) return "";
  /* 防呆：只填了 Project ID（如 nxxw...grwnip）→ 自动补全为完整 URL */
  if(!/^https?:\/\//i.test(u)){
    if(/^[a-z0-9-]{10,40}\.supabase\.co$/i.test(u)) u = "https://"+u;
    else if(/^[a-z0-9-]{10,40}$/i.test(u)) u = "https://"+u+".supabase.co";
    else u = "https://"+u;
  }
  return u;
}
/* 密钥防呆检查：anon key 应为 eyJ 开头的 JWT 或 sb_publishable_ 开头 */
function cloudKeyHint(){
  const k = String(cloudConf().key||"").trim();
  if(cloudIsGitHub()){
    if(!k) return "GitHub 令牌不能为空：需要一个对该仓库有 Contents 读写权限的 PAT";
    if(!/^(github_pat_|ghp_)/.test(k)) return "GitHub 令牌格式不对：应以 github_pat_（或 ghp_）开头，请到 GitHub → Settings → Developer settings 新建";
    return "";
  }
  if(!k) return "API 密钥不能为空";
  if(/^(ap|us|eu)-[a-z]+-?\d*$/i.test(k)) return "你填的是「地区代号」（如 ap-southeast-1），不是密钥。请到 Supabase → Project Settings → API Keys，复制 anon/public key（eyJ 开头的一长串）";
  if(!/^eyJ/.test(k) && !/^sb_publishable_/.test(k)) return "API 密钥格式不对：应为 eyJ 开头（或 sb_publishable_ 开头）的长串。请到 Supabase → Project Settings → API Keys 复制 anon/public key";
  return "";
}
function cloudSpace(){ return String(cloudConf().space||"default").trim() || "default"; }
function cloudRowId(){ return "twb:"+cloudSpace(); }
function cloudHeaders(){
  const c = cloudConf();
  return {"apikey":c.key, "Authorization":"Bearer "+c.key, "Content-Type":"application/json"};
}
function cloudSetStatus(status, msg){
  cloudState = {status, msg:msg||""};
  updateCloudChip();
}
function updateCloudChip(){
  const el = document.querySelector("#btn-cloud"); if(!el) return;
  const txt = {off:"☁ 云同步", syncing:"☁ 同步中…", ok:"☁ 已同步", err:"☁ 同步失败"}[cloudState.status] || "☁ 云同步";
  el.textContent = txt;
  el.title = cloudOn()
    ? (cloudState.status==="err" ? "云端同步失败："+cloudState.msg : "云端同步已开启，点击查看设置")
    : "未配置云端：点击填写云数据库地址与密钥，实现多设备同步";
  el.style.color = cloudState.status==="err" ? "var(--danger)" : "";
}
/* ---------- 免费云端：GitHub 仓库存储（地址形如 https://github.com/用户名/仓库名） ---------- */
let ghSha = null;   // 当前文件 sha，用于更新（避免 409）
function cloudIsGitHub(){ return /github\.com/i.test(String(cloudConf().url||"")); }
function ghRepo(){
  const m = String(cloudConf().url||"").trim().match(/github\.com[/:]([^/#?\s]+)\/([^/#?\s]+)/i);
  if(!m) return null;
  return {owner:m[1], repo:m[2].replace(/\.git$/i,"")};
}
function ghBranch(){ return String(cloudConf().branch||"main").trim() || "main"; }
function ghPath(){
  const s = cloudSpace().replace(/[^\w.\-]/g,"").slice(0,40) || "default";
  return /\.json$/i.test(s) ? s : "twb-"+s+".json";
}
function ghHeaders(){
  const h = {"Accept":"application/vnd.github+json","Content-Type":"application/json"};
  const k = String(cloudConf().key||"").trim();
  if(k) h.Authorization = "Bearer "+k;
  return h;
}
/* UTF-8 安全的 base64 编解码（GitHub Contents API 要求） */
function b64encText(s){
  const bytes = new TextEncoder().encode(s);
  let bin = ""; const CH = 0x8000;
  for(let i=0;i<bytes.length;i+=CH) bin += String.fromCharCode.apply(null, bytes.subarray(i,i+CH));
  return btoa(bin);
}
function b64decText(b64){
  const bin = atob(String(b64||"").replace(/\s/g,""));
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(arr);
}
function ghApiUrl(){
  const r = ghRepo();
  if(!r) throw new Error("GitHub 仓库地址格式应为 https://github.com/用户名/仓库名");
  return "https://api.github.com/repos/"+r.owner+"/"+r.repo+"/contents/"+encodeURIComponent(ghPath());
}
function ghErr(status, text){
  const t = String(text||"").replace(/\s+/g," ").slice(0,140);
  if(status===401||status===403) return "GitHub 拒绝访问（"+status+"）：密钥无效、已过期，或没有该仓库的 Contents 读写权限。";
  if(status===404) return "找不到仓库或数据文件（404）：请检查仓库地址、分支名和密钥权限。";
  return status+" "+t;
}
async function ghRead(){
  const res = await fetch(ghApiUrl()+"?ref="+encodeURIComponent(ghBranch()), {headers:ghHeaders()});
  if(res.status === 404) return null;
  if(!res.ok) throw new Error(ghErr(res.status, await res.text()));
  const j = await res.json();
  ghSha = j.sha;
  const data = JSON.parse(b64decText(j.content));
  return {data, updated_at:new Date(data.__savedAt||Date.now()).toISOString(), sha:j.sha};
}
async function ghWrite(){
  const base = {message:"sync "+new Date().toISOString(), content:b64encText(JSON.stringify(state)), branch:ghBranch()};
  const put = (sha)=>fetch(ghApiUrl(), {
    method:"PUT", headers:ghHeaders(),
    body: JSON.stringify(sha ? Object.assign({}, base, {sha}) : base)
  });
  let res = await put(ghSha);
  if(res.status===409 || res.status===422){
    const cur = await ghRead();          // sha 过期 → 取最新后重试一次
    ghSha = cur && cur.sha;
    res = await put(ghSha);
  }
  if(!res.ok) throw new Error(ghErr(res.status, await res.text()));
  try{ const j = await res.json(); ghSha = (j.content && j.content.sha) || ghSha; }catch(e){}
}
async function cloudPush(){
  if(cloudIsGitHub()) return ghWrite();
  const res = await fetch(cloudBase()+"/rest/v1/"+CLOUD_TABLE, {
    method:"POST",
    headers: Object.assign(cloudHeaders(), {"Prefer":"resolution=merge-duplicates,return=minimal"}),
    body: JSON.stringify([{id:cloudRowId(), data:state, updated_at:new Date().toISOString()}])
  });
  if(!res.ok) throw new Error(res.status+" "+(await res.text()).slice(0,120));
}
async function cloudFetch(){
  if(cloudIsGitHub()) return ghRead();
  const u = cloudBase()+"/rest/v1/"+CLOUD_TABLE+"?select=id,data,updated_at&id=eq."+encodeURIComponent(cloudRowId());
  const res = await fetch(u, {headers:cloudHeaders()});
  if(!res.ok) throw new Error(res.status+" "+(await res.text()).slice(0,120));
  const arr = await res.json();
  return (Array.isArray(arr) && arr[0]) ? arr[0] : null;
}
function applyRemoteState(d){
  if(!d || typeof d!=="object" || !Array.isArray(d.students) || !Array.isArray(d.users)) throw new Error("云端数据不完整");
  const keep = cloudConf();
  Object.keys(state).forEach(k=>delete state[k]);
  Object.assign(state, d);
  state.settings = state.settings || {};
  if(!state.settings.cloud) state.settings.cloud = keep;
  /* 关键：应用后本地时间戳取 max(现在, 云端时间戳)，否则设备时钟略有偏差时
     boot 会永远认为"云端更新"而陷入 拉取→重载 死循环 */
  state.__savedAt = Math.max(Date.now(), d.__savedAt||0);
  cloudApplying = true; save(); cloudApplying = false;
}
function scheduleCloudPush(){
  if(!bootDone || cloudApplying || !cloudOn() || cloudConf().auto===false) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(cloudDoPush, 1200);
}
async function cloudDoPush(){
  if(cloudBusy){ cloudPending = true; return; }
  cloudBusy = true; cloudSetStatus("syncing");
  try{ await cloudPush(); cloudSetStatus("ok"); }
  catch(e){ cloudSetStatus("err", e.message); }
  cloudBusy = false;
  if(cloudPending){ cloudPending = false; cloudDoPush(); }
}
/* 启动同步：本机无数据 → 以云端为准；两边都有 → 较新的一方为准 */
async function cloudBoot(){
  if(!cloudOn()){ cloudSetStatus("off"); bootDone = true; return; }
  cloudSetStatus("syncing");
  try{
    const row = await cloudFetch();
    const remoteTs = (row && row.data && row.data.__savedAt) || 0;
    if(!row){
      if(!hasMeaningfulData()){
        cloudSetStatus("ok"); bootDone = true;
        toast("☁ 云端还没有数据：请先在已录入数据的那台电脑上点「上传本机数据」", true);
        return;
      }
      await cloudPush(); cloudSetStatus("ok");
    }
    else if(!HAD_LOCAL_DATA || remoteTs > (state.__savedAt||0)){
      applyRemoteState(row.data);
      cloudSetStatus("ok");
      bootDone = true;
      toast("☁ 已从云端载入最新数据，正在刷新…");
      setTimeout(()=>location.reload(), 700);
      return;
    }
    else if((state.__savedAt||0) > remoteTs){ await cloudPush(); cloudSetStatus("ok"); }
    else cloudSetStatus("ok");
  }catch(e){ cloudSetStatus("err", e.message); }
  bootDone = true;
}
/* 手动同步（弹窗按钮用）：方向 auto / up / down / test */
async function cloudManual(dir){
  if(!cloudOn()) return "请先填写云数据库地址与密钥";
  const kh = cloudKeyHint();
  if(kh && dir==="test") return "❌ "+kh;
  try{
    if(dir==="test"){
      const row = await cloudFetch();
      return row ? "连接成功：云端已有数据（"+row.updated_at+"）" : "连接成功：云端暂无数据，点「上传本机数据」创建";
    }
    if(dir==="up"){
      await cloudPush(); cloudSetStatus("ok");
      return "已上传到云端（"+new Date().toLocaleTimeString()+"）";
    }
    if(dir==="down"){
      const row = await cloudFetch();
      if(!row) return "云端暂无数据，请先点「上传本机数据」";
      applyRemoteState(row.data); cloudSetStatus("ok");
      toast("☁ 已用云端数据覆盖本机，正在刷新…");
      setTimeout(()=>location.reload(), 700);
      return "已拉取云端数据";
    }
    return "";
  }catch(e){
    cloudSetStatus("err", e.message);
    let m = "失败："+e.message;
    /* 常见错误翻译成用户能看懂的提示 */
    if(/42P01|PGRST205|does not exist|Could not find the table/i.test(e.message))
      m = "失败：云端还没有建数据表。请按《云同步配置指南》在 Supabase SQL Editor 执行建表 SQL，再重试";
    else if(/42501|42501|privileges|insufficient_privilege/i.test(e.message))
      m = "失败：云端表权限未开放。请按《云同步配置指南》末尾的「权限修复 SQL」在 Supabase SQL Editor 执行一次，再重试";
    else if(cloudKeyHint()) m = "失败："+cloudKeyHint();
    return m;
  }
}
function cloudModal(){
  const c = cloudConf();
  const msg = cloudOn()
    ? (cloudState.status==="ok" ? "最近同步：成功" : cloudState.status==="err" ? "最近同步失败："+cloudState.msg : "已配置，等待同步")
    : "尚未配置：填写后即可多设备共享同一份数据";
  const m = modal("云端同步设置", `
    <div class="form-grid">
      <label class="full">云端地址（GitHub 仓库地址，或 Supabase Project URL）
        <input id="cl-url" value="${esc(c.url||"")}" placeholder="https://github.com/用户名/仓库名"></label>
      <label class="full">访问令牌（GitHub 用 github_pat_ 开头；Supabase 用 eyJ 开头的 anon key）
        <input id="cl-key" value="${esc(c.key||"")}" placeholder="github_pat_11... 或 eyJhbGciOi..."></label>
      <label>空间标识（同一份数据填同一串）
        <input id="cl-space" value="${esc(c.space||"default")}" placeholder="如 班级随机串"></label>
      <label>自动上传
        <select id="cl-auto">
          <option value="1" ${c.auto!==false?"selected":""}>开启（数据改动后自动上传）</option>
          <option value="0" ${c.auto===false?"selected":""}>关闭（仅手动上传）</option>
        </select></label>
      <label class="full muted">配置一次即全自动：本机数据改动后自动上传云端；打开页面自动载入云端最新数据；其他设备更新时顶栏会提示一键刷新。换设备时点「生成同步码」，在新设备登录页粘贴即可一键恢复。</label>
      <label class="full" id="cl-msg" style="color:var(--text2)">${esc(msg)}</label>
    </div>`,
    [{text:"关闭"},
     {text:"生成同步码", fn:()=>{
        readCloudForm();
        if(!cloudOn()){ setCloudMsg("请先填写云数据库地址与密钥，再生成同步码"); return false; }
        const code = makeSyncCode();
        const sc = modal("同步码（发给同事，新设备一键恢复）", `
          <textarea readonly rows="4" style="width:100%" id="sc-code">${esc(code)}</textarea>
          <p class="muted" style="margin-top:8px">新设备打开网址 → 登录页点「☁ 换了设备？点这里」→ 粘贴此码 → 恢复数据。此后两台设备自动保持同步。</p>`,
          [{text:"关闭"},
           {text:"复制同步码", cls:"btn-primary", fn:(mm)=>{
              const ta = mm.el.querySelector("#sc-code");
              ta.focus(); ta.select();
              try{ document.execCommand("copy"); toast("✅ 同步码已复制"); }
              catch(e){ if(navigator.clipboard) navigator.clipboard.writeText(code).then(()=>toast("✅ 同步码已复制")); }
              return false;
           }}]);
        return false;
     }},
     {text:"测试连接", fn:()=>{ readCloudForm(); setCloudMsg("检测中…"); cloudManual("test").then(setCloudMsg); return false; }},
     {text:"上传本机数据", fn:()=>{
        readCloudForm();
        const go = ()=>{ setCloudMsg("上传中…"); cloudManual("up").then(setCloudMsg); };
        if(!hasMeaningfulData()) confirmBox("本机目前没有学生/笔记/考勤数据，上传会把云端现有内容替换为本机的空数据。确认继续？", go);
        else go();
        return false;
      }},
     {text:"从云端拉取", fn:()=>{
        readCloudForm();
        confirmBox("用云端数据覆盖本机全部数据？本机当前内容将被替换（建议先点「上传」保留本机数据）。", ()=>{
          setCloudMsg("拉取中…"); cloudManual("down").then(setCloudMsg);
        });
        return false;
      }},
     {text:"保存配置", cls:"btn-primary", fn:()=>{
        readCloudForm(); toast(cloudOn()?"☁ 云端配置已保存，开始自动同步…":"已保存（尚未填写完整）");
        cloudBoot(); startCloudPoll();
      }}]);
  function setCloudMsg(t){ const el = m.el.querySelector("#cl-msg"); if(el) el.textContent = "状态："+t; }
  function readCloudForm(){
    const el = m.el;
    state.settings.cloud = {
      url: el.querySelector("#cl-url").value.trim(),
      key: el.querySelector("#cl-key").value.trim(),
      space: el.querySelector("#cl-space").value.trim() || "default",
      auto: el.querySelector("#cl-auto").value === "1"
    };
    cloudApplying = true; save(); cloudApplying = false;
    updateCloudChip();
  }
}

/* ---------- v38 同步码 / 换设备一键恢复 / 云端轮询 ---------- */
function makeSyncCode(){
  const c = cloudConf();
  if(!cloudOn()) return "";
  return btoa(unescape(encodeURIComponent(JSON.stringify({u:c.url, k:c.key, s:c.space||"default"}))));
}
function parseSyncCode(code){
  const o = JSON.parse(decodeURIComponent(escape(atob(String(code||"").trim()))));
  if(!o || !o.u || !o.k) throw new Error("同步码格式不正确");
  return o;
}
/* 登录页「换了设备」入口：粘贴同步码（或手填地址密钥）→ 保存配置 → 自动拉取 */
function cloudRestoreModal(){
  const m = modal("☁ 换设备恢复数据", `
    <div class="form-grid">
      <label class="full">同步码<span class="muted">（在原来那台电脑的「☁ 云同步」设置里点「生成同步码」复制得到）</span>
        <textarea id="cr-code" rows="3" placeholder="粘贴同步码…"></textarea></label>
      <label class="full muted">没有同步码也可手动填写：云端地址（GitHub 仓库地址 / Supabase Project URL）
        <input id="cr-url" placeholder="https://github.com/用户名/仓库名"></label>
      <label class="full muted">访问令牌（GitHub 的 github_pat_… / Supabase 的 eyJ…）
        <input id="cr-key" placeholder="github_pat_… 或 eyJ…"></label>
      <label class="full" id="cr-msg" style="color:var(--text2)"></label>
    </div>`,
    [{text:"关闭"},
     {text:"恢复数据", cls:"btn-primary", fn:()=>{
        const el = m.el, msg = t=>{ const n = el.querySelector("#cr-msg"); if(n) n.textContent = t; };
        try{
          const code = el.querySelector("#cr-code").value.trim();
          const url = el.querySelector("#cr-url").value.trim(), key = el.querySelector("#cr-key").value.trim();
          let conf;
          if(code) conf = parseSyncCode(code);
          else if(url && key) conf = {u:url, k:key, s:"default"};
          else { msg("请先粘贴同步码，或填写地址与密钥"); return false; }
          state.settings.cloud = {url:conf.u, key:conf.k, space:conf.s||"default", auto:true};
          cloudApplying = true; save(); cloudApplying = false;
          msg("配置已保存，正在从云端拉取数据…");
          cloudManual("down").then(r=>msg(r));
          return false;
        }catch(e){ msg("❌ "+e.message); return false; }
     }}]);
}
/* 每 45 秒检查云端是否有其他设备的更新，有则提示一键刷新（不静默覆盖，避免冲掉正在编辑的内容） */
let cloudPollTimer = null, cloudRefreshBar = null;
function startCloudPoll(){
  clearInterval(cloudPollTimer);
  if(!cloudOn()) return;
  cloudPollTimer = setInterval(cloudPollOnce, 45000);
}
async function cloudPollOnce(){
  if(!bootDone || cloudBusy || cloudApplying || !cloudOn() || document.hidden) return;
  try{
    const row = await cloudFetch();
    if(!row || !row.data) return;
    const remoteTs = (row.data.__savedAt)||0;
    if(remoteTs > (state.__savedAt||0) + 1500) showCloudRefresh();
  }catch(e){}
}
function showCloudRefresh(){
  if(cloudRefreshBar && document.body.contains(cloudRefreshBar)) return;
  const b = document.createElement("div");
  b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7B74D8;color:#fff;padding:8px 14px;font-size:13px;display:flex;gap:12px;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.15)";
  b.innerHTML = `<span>☁ 其他设备更新了数据，本机不是最新</span><button style="background:#fff;color:#7B74D8;border:0;border-radius:6px;padding:4px 12px;cursor:pointer;font-weight:600">立即刷新</button>`;
  b.querySelector("button").onclick = ()=>location.reload();
  document.body.appendChild(b);
  cloudRefreshBar = b;
  setTimeout(()=>{ if(b.parentNode) b.remove(); if(cloudRefreshBar===b) cloudRefreshBar = null; }, 120000);
}

/* ---------- 班级体系 ---------- */
function allClasses(){ return state.classes.map(c=>c.name); }
function classObj(name){ return state.classes.find(c=>c.name===name); }
function curCls(){
  const list = allClasses();
  const saved = state.settings["cur_"+(session?session.account:"_")];
  return list.includes(saved)? saved : (list[0]||"未命名班级");
}
function setCurCls(c){ state.settings["cur_"+(session?session.account:"_")]=c; save(); }

/* ---------- 会话 ---------- */
const SUPER = {account:"ZINNIA", password:"Zinnia1005", name:"ZINNIA", label:"超级管理员", scope:"全校全部数据（教师账号 / 班级 / 学生 / 密码管理）"};
function findAccount(u, p){
  u = (u||"").trim();
  if(u===SUPER.account) return p===SUPER.password ? {role:"schooladmin", name:SUPER.name, label:SUPER.label, scope:SUPER.scope, account:u, super:true} : null;
  const t = (state.users||[]).find(x=>x.account===u && x.status!=="停用");
  if(t && p===(t.password||"123456"))
    return {role: t.role==="班主任"?"headteacher":"subjectteacher", name:t.name, label:t.role, scope:(t.classes||"本人授课班级")+"（可在顶栏切换班级）", account:u};
  const s = (state.students||[]).find(x=>x.name===u);
  if(s && p==="123456")
    return {role:"student", name:s.name, label:"学生", scope:"仅本班内容（只读）", account:s.name, cls:s.cls, stuId:s.id};
  return null;
}
let session = null;

/* ---------- 导航 ---------- */
const NICO = {dash_ht:"🏠",students:"🎒",classinfo:"🏫",seating:"🪑",att_ht:"📋",moral:"⭐",scores:"📈",comm:"💬",
  ainotice:"🪄",shares:"🔗",stories:"🌱",problems:"🧩",todos:"✅",dash_st:"🏠",timetable:"🗓️",rollcall:"🙋",
  homerec:"📚",examrec:"🎯",
  points:"🌟",notes:"📓",duties:"📢",homework:"📝",adm_overview:"📊",adm_users:"👥",adm_cls:"🏫",adm_roles:"🛡️",
  adm_logs:"📜",adm_set:"⚙️",stu_dash:"🏠",stu_hw:"📝",stu_notes:"📓",stu_points:"🌟"};
const NAV = {
  headteacher: [
    ["班主任端", [
      ["dash_ht","工作台"],["students","学生档案"],["classinfo","班级档案"],["seating","座位与班务"],
      ["att_ht","考勤管理"],["homerec","作业完成记录"],["moral","德育量化"],["scores","成绩与学情"],["examrec","考试成绩分析"],["comm","家校沟通"],
      ["ainotice","AI 通知整理"],["shares","通知与分享"],["stories","教育故事"],["problems","学生问题档案"],["todos","待办任务"],
    ]]],
  subjectteacher: [
    ["任课教师端", [
      ["dash_st","教师工作台"],["timetable","个人课表"],["rollcall","学生考勤"],["points","积分功能"],
      ["homework","作业与练习"],["homerec","作业完成记录"],["scores","成绩与学情"],["examrec","考试成绩分析"],["notes","学习笔记"],["duties","监考/值班/会议"],["stories","教育故事"],
      ["shares","通知与分享"],["todos","待办任务"],
    ]]],
  schooladmin: [
    ["超级管理员端", [
      ["adm_overview","管理总览"],["adm_users","教师账号管理"],["adm_cls","班级与学生"],
      ["adm_roles","角色与权限"],["adm_logs","操作日志"],["adm_set","系统设置"],
    ]]],
  student: [
    ["学生端", [
      ["stu_dash","我的工作台"],["stu_hw","作业与练习"],["stu_notes","教师笔记"],["stu_points","我的积分"],
    ]]],
};

/* ---------- 图片查看器（点击放大 · 左右翻页 · 键盘 ←/→/Esc） ---------- */
function imgViewer(imgs, idx=0){
  if(!imgs || !imgs.length) return;
  let i = Math.min(Math.max(0, idx), imgs.length-1);
  const many = imgs.length > 1;
  const ov = document.createElement("div");
  ov.className = "img-viewer";
  ov.innerHTML = `
    <button class="iv-btn iv-close" title="关闭 (Esc)">✕</button>
    ${many?`<button class="iv-btn iv-prev" title="上一张 (←)">‹</button><button class="iv-btn iv-next" title="下一张 (→)">›</button>`:""}
    <img class="iv-img" alt="查看图片">
    ${many?`<div class="iv-count"></div>`:""}`;
  document.body.appendChild(ov);
  const img = ov.querySelector(".iv-img"), cnt = ov.querySelector(".iv-count");
  const prevB = ov.querySelector(".iv-prev"), nextB = ov.querySelector(".iv-next");
  const show = ()=>{ img.src = imgs[i]; if(cnt) cnt.textContent = `${i+1} / ${imgs.length}`; };
  const prev = ()=>{ i = (i-1+imgs.length)%imgs.length; show(); };
  const next = ()=>{ i = (i+1)%imgs.length; show(); };
  const close = ()=>{ document.removeEventListener("keydown", onKey); ov.remove(); };
  function onKey(e){
    if(e.key==="Escape") close();
    else if(e.key==="ArrowLeft" && prevB) prev();
    else if(e.key==="ArrowRight" && nextB) next();
  }
  ov.querySelector(".iv-close").onclick = close;
  if(prevB) prevB.onclick = prev;
  if(nextB) nextB.onclick = next;
  document.addEventListener("keydown", onKey);
  ov.onclick = e=>{ if(e.target===ov) close(); };
  show();
}

/* ---------- 登录 ---------- */
function renderDemoChips(){
  const chips = [{u:SUPER.account, b:"超级管理员"}];
  const ht = state.users.find(u=>u.role==="班主任");
  const tt = state.users.find(u=>u.role==="任课教师");
  const stu = state.students[0];
  if(ht) chips.push({u:ht.account, b:"班主任"});
  if(tt) chips.push({u:tt.account, b:"任课教师"});
  if(stu) chips.push({u:stu.name, b:"学生"});
  // 仅作为身份提示，不携带/不回填任何账号密码信息，防止泄露
  $("#demo-chips").innerHTML = chips.map(c=>`<div class="demo-chip" data-role="${esc(c.b)}"><b>${esc(c.b)}</b><small>点击选择身份</small></div>`).join("");
  document.querySelectorAll(".demo-chip").forEach(c=>{
    c.onclick = ()=>{
      document.querySelectorAll(".demo-chip").forEach(x=>x.classList.remove("active"));
      c.classList.add("active");
      $("#login-user").value = "";
      $("#login-pass").value = "";
      $("#login-user").focus();
    };
  });
}
function initLogin(){
  renderDemoChips();
  $("#login-tip").innerHTML = `教师/学生初始密码为 123456 · 超级管理员每次登录均需输入账号密码<br><span class="link" id="login-cloud">☁ 换了设备？点这里用云端数据恢复</span>`;
  const lc = $("#login-cloud");
  if(lc) lc.onclick = cloudRestoreModal;
  $("#login-form").onsubmit = e=>{
    e.preventDefault();
    const u = $("#login-user").value.trim(), p = $("#login-pass").value;
    const acc = findAccount(u, p);
    if(!acc){ $("#login-error").textContent = "账号或密码错误（连续失败有登录保护）"; return; }
    session = {...acc, time:new Date().toLocaleString()};
    if(acc.super) localStorage.removeItem("twb_session");   // 超管不记忆会话，每次登录必须重新输入
    else localStorage.setItem("twb_session", JSON.stringify(session));
    enterApp();
  };
}
function enterApp(){
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  renderShell();
  navigate(defaultPage());
}
function defaultPage(){
  return {headteacher:"dash_ht", subjectteacher:"dash_st", schooladmin:"adm_overview", student:"stu_dash"}[session.role];
}
function logout(){
  localStorage.removeItem("twb_session");
  location.reload();
}

/* ---------- 外壳渲染 ---------- */
/* ---------- 侧栏拖拽调宽 ---------- */
function initResizer(){
  const rz = $("#side-resizer");
  if(!rz) return;
  document.documentElement.style.setProperty("--sidebar-w", (state.settings.sideW||232)+"px");
  let startX=0, startW=0, moving=false;
  const down = e=>{
    moving=true; startX=e.clientX; startW=state.settings.sideW||232;
    rz.classList.add("dragging"); document.body.style.userSelect="none";
    e.preventDefault();
  };
  const move = e=>{
    if(!moving) return;
    const w = Math.min(420, Math.max(168, startW + e.clientX - startX));
    state.settings.sideW = w;
    document.documentElement.style.setProperty("--sidebar-w", w+"px");
  };
  const up = ()=>{
    if(!moving) return;
    moving=false; rz.classList.remove("dragging"); document.body.style.userSelect="";
    save();
  };
  rz.onmousedown = down;
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  // 触屏
  rz.ontouchstart = e=>{ down(e.touches[0]); };
  window.addEventListener("touchmove", e=>{ if(moving) move(e.touches[0]); }, {passive:true});
  window.addEventListener("touchend", up);
}

let currentPage = "";
function renderShell(){
  const su = $("#side-user");
  su.innerHTML = `<b>${esc(session.name)}</b>　<span class="tag blue">${esc(session.label)}</span>
    <div style="margin-top:5px">账号：${esc(session.account)} · ${esc(session.time)} 登录</div>`;
  const nav = NAV[session.role];
  $("#side-nav").innerHTML = nav.map(([g,items])=>
    `<div class="nav-group">${esc(g)}</div>` + items.map(([id,label],i)=>
      `<div class="nav-item" data-p="${id}" style="animation-delay:${i*40}ms"><span class="nico">${NICO[id]||"▪"}</span>${esc(label)}</div>`).join("")).join("");
  document.querySelectorAll(".nav-item").forEach(n=>n.onclick=()=>navigate(n.dataset.p));
  initResizer();
  $("#btn-logout").onclick = logout;
  // —— 云端同步（多设备共享同一份数据） ——
  $("#btn-cloud").onclick = cloudModal;
  updateCloudChip();
  // —— 数据备份 / 恢复（数据存于本机浏览器，换设备/浏览器时用备份文件迁移） ——
  $("#btn-backup").onclick = ()=>{
    download("教师工作台备份-"+todayStr()+".json", JSON.stringify(state,null,2), "application/json");
    toast("📦 备份文件已下载，请妥善保存");
  };
  $("#btn-restore").onclick = ()=>$("#restore-file").click();
  $("#restore-file").onchange = e=>{
    const f = e.target.files[0]; e.target.value = "";
    if(!f) return;
    const r = new FileReader();
    r.onload = ()=>{
      try{
        const d = JSON.parse(r.result);
        if(!d || !Array.isArray(d.students) || !Array.isArray(d.users)) throw new Error("bad");
        confirmBox(`将从备份「${f.name}」恢复全部数据，并覆盖当前内容（${(d.students||[]).length} 名学生 / ${(d.notes||[]).length} 条笔记）。确认继续？`, ()=>{
          Object.keys(state).forEach(k=>delete state[k]);
          Object.assign(state, d); save();
          toast("✅ 数据已恢复，即将刷新"); setTimeout(()=>location.reload(), 800);
        });
      }catch(err){ toast("备份文件无效，请选择本平台导出的 .json 文件", true); }
    };
    r.readAsText(f);
  };
  $("#btn-theme").onclick = ()=>{
    const cur = document.documentElement.getAttribute("data-theme")==="light"?"dark":"light";
    document.documentElement.setAttribute("data-theme", cur);
    state.settings.dark = cur==="dark"; save();
  };
  document.documentElement.setAttribute("data-theme", state.settings.dark?"dark":"light");
  $("#btn-nav-toggle").onclick = ()=>$("#sidebar").classList.toggle("open");
  // 顶栏：班级切换（教师） / 资料编辑
  if(["headteacher","subjectteacher"].includes(session.role)){
    $("#topbar-right").innerHTML = `
      <div class="cls-switch">
        <span class="muted">🏫</span>
        <select id="cls-switch">${allClasses().map(c=>`<option ${c===curCls()?"selected":""}>${esc(c)}</option>`).join("")}</select>
        <button class="btn btn-sm" id="cls-manage" title="班级管理">管理</button>
      </div>
      <button class="btn btn-sm" id="btn-profile">个人资料</button>`;
    $("#cls-switch").onchange = e=>{ setCurCls(e.target.value); toast("已切换到 "+e.target.value); PAGES[currentPage]&&PAGES[currentPage](); };
    $("#cls-manage").onclick = classManagerModal;
  } else {
    $("#topbar-right").innerHTML = `<button class="btn btn-sm" id="btn-profile">个人资料</button>`;
  }
  $("#btn-profile").onclick = showProfile;
}
/* 教师班级管理：新增/删除班级，Excel/CSV 导入学生名单 */
function classManagerModal(){
  function renderCls(){
    $("#cm-cls-list").innerHTML = allClasses().map(c=>{
      const co = classObj(c), n = state.students.filter(s=>s.cls===c).length;
      return `<div class="comm-item"><b>${esc(c)}</b><span class="tag blue">${n} 名学生</span>
        <span class="muted">${co&&co.headteacher?("班主任："+esc(co.headteacher)):""}</span>
        <div class="meta"><span class="link" data-cmuse="${esc(c)}">切换到此班</span> · <span class="link" style="color:var(--danger)" data-cmdel="${esc(c)}">删除班级</span></div></div>`;
    }).join("") || `<div class="empty">暂无班级</div>`;
    document.querySelectorAll("[data-cmuse]").forEach(e=>e.onclick=()=>{ setCurCls(e.dataset.cmuse); renderCls(); });
    document.querySelectorAll("[data-cmdel]").forEach(e=>e.onclick=()=>{
      const c = e.dataset.cmdel;
      const n = state.students.filter(s=>s.cls===c).length;
      confirmBox(`确认删除班级「${c}」？班内 ${n} 名学生档案将一并删除，学生账号随之失效。`, ()=>{
        state.classes = state.classes.filter(x=>x.name!==c);
        state.students = state.students.filter(s=>s.cls!==c);
        if(allClasses().length) setCurCls(allClasses()[0]);
        save(); toast("班级已删除"); renderCls();
        $("#cls-switch") && ($("#cls-switch").innerHTML = allClasses().map(cc=>`<option ${cc===curCls()?"selected":""}>${esc(cc)}</option>`).join(""));
      });
    });
  }
  modal("班级管理", `
    <div class="toolbar">
      <input id="cm-new" placeholder="新班级名称，如 初二(3)班" style="min-width:160px">
      <button class="btn btn-primary" id="cm-add">＋ 新增班级</button>
    </div>
    <div id="cm-cls-list" style="margin:10px 0"></div>
    <div class="toolbar" style="border-top:1px solid var(--border);padding-top:10px">
      <select id="cm-imp-cls">${allClasses().map(c=>`<option ${c===curCls()?"selected":""}>${esc(c)}</option>`).join("")}</select>
      <button class="btn" id="cm-imp">Excel/CSV 导入学生名单</button>
    </div>
    <p class="muted" style="margin-top:8px">导入格式（每行）：姓名,性别,监护人,电话 —— 学生账号默认为姓名，初始密码 123456，学生不可修改。</p>`,
    [{text:"关闭"}]);
  renderCls();
  $("#cm-add").onclick = ()=>{
    const v = $("#cm-new").value.trim();
    if(!v){ toast("请填写班级名称", true); return; }
    if(allClasses().includes(v)){ toast("班级已存在", true); return; }
    state.classes.push({id:uid("C"), name:v, headteacher:session.role==="headteacher"?session.name:""});
    setCurCls(v); save(); toast("班级已创建并切换"); renderCls();
    $("#cls-switch") && ($("#cls-switch").innerHTML = allClasses().map(cc=>`<option ${cc===curCls()?"selected":""}>${esc(cc)}</option>`).join(""));
  };
  $("#cm-imp").onclick = ()=>{
    const c = $("#cm-imp-cls").value;
    importModal("学生名单导入格式（每行）：姓名,性别,监护人,电话", lines=>{
      let n=0;
      lines.forEach(l=>{
        const [name,gender,guardian,phone] = l.split(",").map(x=>x?.trim());
        if(name && !state.students.some(s=>s.cls===c&&s.name===name)){
          state.students.push({id:uid("HT"),name,cls:c,gender:gender||"男",guardian:guardian||"",phone:phone||"",tags:[],remark:""});
          n++;
        }
      });
      save(); toast(`已向「${c}」导入 ${n} 名学生（重复跳过）`); renderCls();
    });
  };
}
function showProfile(){
  const isStu = session.role==="student";
  modal("个人资料", `
    <div class="form-grid">
      <label>姓名<input id="pf-name" value="${esc(session.name)}" ${isStu?"disabled":""}></label>
      <label>角色<input value="${esc(session.label)}" disabled></label>
      <label class="full">数据范围<input value="${esc(session.scope)}" disabled></label>
      ${isStu?`<label class="full muted">学生账号为姓名，密码固定为 123456 且不可修改；如需更正姓名请联系超级管理员。</label>`
        :`<label class="full">手机号<input id="pf-phone" placeholder="选填"></label>
          <label class="full">简介<textarea id="pf-bio" rows="2" placeholder="一句话介绍"></textarea></label>`}
    </div>`,
    [{text:"保存", cls:"btn-primary", fn:()=>{
      if(!isStu) session.name = $("#pf-name").value.trim()||session.name;
      localStorage.setItem("twb_session", JSON.stringify(session));
      renderShell(); toast("个人资料已保存（本地）");
    }}]);
}
function navigate(page){
  currentPage = page;
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.toggle("active", n.dataset.p===page));
  const nav = NAV[session.role].flatMap(g=>g[1]);
  const item = nav.find(i=>i[0]===page);
  $("#page-title").textContent = item?item[1]:"";
  $("#sidebar").classList.remove("open");
  renderScope();
  PAGES[page] ? PAGES[page]() : ($("#page-body").innerHTML = `<div class="panel"><div class="empty">页面建设中</div></div>`);
  $("#page-body").scrollTop = 0;
}
function renderScope(){
  const s = session.scope;
  $("#scope-bar").innerHTML =
    `<span class="scope-tag">数据范围：${esc(s)}</span>
     <span class="scope-tag">角色：${esc(session.label)}</span>
     <span class="scope-tag warn">敏感数据已按租户隔离，所有访问留痕审计</span>`;
}

/* ---------- 通用组件 ---------- */
function statCard(lab, val, cls="", sub=""){ return `<div class="stat-card ${cls}"><div class="lab">${lab}</div><div class="val">${val}</div>${sub?`<div class="muted" style="font-size:11px;margin-top:4px">${sub}</div>`:""}</div>`; }
function panel(title, bodyHTML, headRight="", flush=false){
  return `<div class="panel"><div class="panel-head"><h3>${title}</h3><div class="right">${headRight}</div></div>
    <div class="panel-body${flush?" flush":""}">${bodyHTML}</div></div>`;
}
function tableHTML(headers, rows, opts={}){
  if(!rows.length) return `<div class="empty">暂无数据</div>`;
  return `<div class="table-wrap"><table class="data ${opts.cls||""}">
    <thead><tr>${headers.map((h,i)=>`<th class="${opts.noSort?"no-sort":""}" data-ci="${i}">${h}${opts.noSort?"":" ⌃⌄"}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r=> typeof r==="string"
      ? r
      : `<tr class="${opts.rowClick?"clickable":""}" ${r.__attr||""}>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}
// 简易表格排序
function bindSort(container, data, render){
  container.querySelectorAll("th[data-ci]").forEach(th=>{
    th.onclick = ()=>{
      const ci = +th.dataset.ci;
      data.sort((a,b)=>{
        const va = a[ci]??"", vb = b[ci]??"";
        const na = parseFloat(String(va).replace(/[^\d.-]/g,"")), nb = parseFloat(String(vb).replace(/[^\d.-]/g,""));
        if(!isNaN(na)&&!isNaN(nb)) return na-nb;
        return String(va).localeCompare(String(vb),"zh");
      });
      render();
    };
  });
}
// SVG 折线图
function lineChart(labels, series, opts={}){
  const W = 640, H = 240, L = 40, R = 12, T = 14, B = 26;
  const yMax = opts.yMax || Math.max(100, ...series.flatMap(s=>s.data.filter(v=>v!=null)));
  const iw = W-L-R, ih = H-T-B;
  const x = i => L + (labels.length<2? iw/2 : iw*i/(labels.length-1));
  const y = v => T + ih*(1 - v/yMax);
  let grid = "";
  for(let g=0; g<=4; g++){
    const gv = yMax*g/4, gy = y(gv);
    grid += `<line x1="${L}" y1="${gy}" x2="${W-R}" y2="${gy}" stroke="var(--border)" stroke-dasharray="3 3"/>
      <text x="${L-6}" y="${gy+3}" text-anchor="end" font-size="9" fill="var(--text3)">${Math.round(gv)}</text>`;
  }
  let lines = "";
  series.forEach(s=>{
    let path = "", started = false;
    s.data.forEach((v,i)=>{
      if(v==null){ started=false; return; }
      path += (started?" L":" M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
      started = true;
    });
    lines += `<path d="${path}" fill="none" stroke="${s.color||"#3d8bfd"}" stroke-width="2"/>`;
    s.data.forEach((v,i)=>{ if(v!=null) lines += `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color||"#3d8bfd"}"/>`; });
  });
  const xlabels = labels.map((l,i)=>`<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--text3)">${esc(l)}</text>`).join("");
  return `<div class="chart-box"><svg viewBox="0 0 ${W} ${H}" width="100%">${grid}${lines}${xlabels}</svg>
    <div class="legend">${series.map(s=>`<span><i style="background:${s.color||"#3d8bfd"}"></i>${esc(s.name)}</span>`).join("")}</div></div>`;
}

/* ================================================================
   页面实现
================================================================ */
const PAGES = {};

/* ---------- 班主任 · 工作台 ---------- */
function greetWord(){
  const h = new Date().getHours();
  return h<6?"夜深了":h<9?"早上好":h<12?"上午好":h<14?"中午好":h<18?"下午好":"晚上好";
}
/* ---------- 近七次统计（作业提交 / 考勤到课，联动顶栏班级） ----------
   说明：横轴不再是"最近七天"，而是"最近七次记录"——
        作业：该班最近 7 条已汇入的作业记录（每次授课=一次）；
        考勤：该班最近 7 次点名/考勤记录（课时点名与班主任日考勤各算一次）。
        次数不足 7 次时按实际条数展示，不补空柱子；没有任何记录时给出空状态提示。 */
const CHART_N = 7;
/* 节次权重：按「课表设置」中登记的节次顺序排序，未登记的节次排到最后 */
function periodIdx(p){
  const arr = Array.isArray(state.periods)? state.periods : [];
  const i = arr.indexOf(p);
  return i<0? 99 : i;
}
/* 记录排序：先日期，再节次，最后落库时间（同日同节次可能多次汇入） */
function byDateTime(a,b){
  return String(a.date||"").localeCompare(String(b.date||""))
      || periodIdx(a.period)-periodIdx(b.period)
      || (a.at||0)-(b.at||0);
}
/* 柱下短标签：09/16，若该次有节次则补成 09/16·2 */
function shortLabel(date, period){
  const s = String(date||"").slice(5).replace("-","/");
  const n = /(\d+)/.exec(period||"");
  return n? s+"·"+n[1] : s;
}
/* 近七次作业提交：每次汇入的作业记录算一次 */
function hwRecentStats(cls, n){
  const list = hwSessions().filter(s=>s.cls===cls)
    .map(s=>Object.assign({}, s, {at:s.savedAt||0}))
    .sort(byDateTime).slice(-(n||CHART_N));
  return list.map(s=>{
    let ok=0, tot=0;
    hwMatch(s).rows.forEach(x=>{ if(!s.ignored[x.s.name]){ tot++; if(x.sub) ok++; } });
    return { key:s.date+" "+s.period+(s.subject?(" · "+s.subject):""), label:shortLabel(s.date,s.period), rate: tot? ok/tot : null };
  });
}
/* 近七次考勤到课：课时点名（学生考勤）+ 班主任日考勤，各算一次 */
function attRecentStats(cls, n){
  const list = [];
  Object.keys(state.rollcall||{}).forEach(k=>{
    const info = rcParseKey(k);
    if(info.cls!==cls) return;
    let ok=0, tot=0;
    Object.values(state.rollcall[k]||{}).forEach(v=>{ if(["到课","请假","旷课"].includes(v)){ tot++; if(v==="到课") ok++; } });
    list.push({ date:info.date, period:info.period, key:k, at:0, label:shortLabel(info.date,info.period), rate: tot? ok/tot : null });
  });
  Object.keys(state.attHT||{}).forEach(dk=>{
    const da = (state.attHT||{})[dk];
    if(!da || !Object.keys(da).length) return;
    let ok=0, tot=0;
    state.students.filter(s=>s.cls===cls).forEach(s=>{ tot++; if((da[s.id]||"到课")==="到课") ok++; });
    if(!tot) return;
    list.push({ date:dk, period:"全天", key:dk+" 全天考勤", at:0, label:shortLabel(dk,""), rate: ok/tot });
  });
  return list.sort(byDateTime).slice(-(n||CHART_N));
}
function barChartHTML(stats, color, emptyTip){
  if(!stats.length) return `<div class="empty" style="padding:30px 12px"><span class="eico">📊</span>${esc(emptyTip||"暂无记录")}</div>`;
  return `<div class="barchart">` + stats.map(x=>{
    const pct = x.rate==null? 0 : Math.round(x.rate*100);
    const h = x.rate==null? 5 : Math.max(6, pct);
    return `<div class="bar-col" title="${esc(x.key||x.label)}　${x.rate==null?"暂无记录":pct+"%"}">
      <div class="bar-v">${x.rate==null?"—":pct+"%"}</div>
      <div class="bar-track"><i style="height:${h}%;background:${color}"></i></div>
      <div class="bar-l">${esc(x.label)}</div></div>`;
  }).join("") + `</div>`;
}
function recentAvg(stats){
  const v = stats.filter(x=>x.rate!=null).map(x=>x.rate);
  return v.length? (v.reduce((a,b)=>a+b,0)/v.length*100).toFixed(0)+"%" : "—";
}
function recentChartPanels(cls){
  const hw = hwRecentStats(cls), at = attRecentStats(cls);
  const hwTip = `${esc(cls)}还没有汇入过作业记录，去「作业完成记录」选好日期与节次、选择文件夹汇入吧`;
  const atTip = `${esc(cls)}还没有考勤记录，去「学生考勤」点名或登记日考勤吧`;
  return `<div class="grid-2" style="margin-bottom:20px">
    ${panel(`近七次作业提交情况 · ${esc(cls)}`,
      barChartHTML(hw,"var(--chart1)",hwTip) +
      `<div class="chart-foot"><span>近 ${hw.length} 次平均提交率 <b>${recentAvg(hw)}</b></span><span class="link" data-goto="homerec">查看作业完成记录表 →</span></div>`)}
    ${panel(`近七次考勤到课情况 · ${esc(cls)}`,
      barChartHTML(at,"var(--chart2)",atTip) +
      `<div class="chart-foot"><span>近 ${at.length} 次平均到课率 <b>${recentAvg(at)}</b></span><span class="link" data-goto="rollcall">去课堂点名 →</span></div>`)}
  </div>`;
}

PAGES.dash_ht = function(){
  const cls = curCls();
  const st = state.students.filter(s=>s.cls===cls);
  const att = state.attHT[todayStr()]||{};
  const okN = st.filter(s=>(att[s.id]||"到课")==="到课").length;
  const lastExam = state.exams[state.exams.length-1];
  const mathAvg = (()=>{ if(!lastExam) return "—"; const sc = state.scores[lastExam.id][cls]||{};
    const v = st.map(s=>sc[s.name]?.["数学"]).filter(v=>v!=null); return v.length? (v.reduce((a,b)=>a+b,0)/v.length).toFixed(1):"—"; })();
  const receipts = state.notices.filter(n=>n.cls===cls);
  const pend = receipts.reduce((a,n)=>a+(n.receipts.total-n.receipts.confirmed),0);
  const todos = state.todos.filter(t=>t.owner==="headteacher"&&!t.done);
  const attPct = st.length? (okN/st.length*100).toFixed(0)+"%":"—";
  $("#page-body").innerHTML = `
    <div class="hero-greet">
      <h2>${greetWord()}，${esc(session.name)}。<span class="hl">今天从清晰开始。</span></h2>
      <p>${esc(cls)} · 共 ${st.length} 名学生 · ${todos.length} 项待办等待处理 · ${state.tenant.motto?("班训："+esc(state.tenant.motto)):"可在「班级档案」完善班级信息"}</p>
      <div class="toolbar" style="margin:14px 0 0">
        <button class="btn btn-primary" data-goto="students">🎒 录入学生</button>
        <button class="btn" data-goto="att_ht">📋 登记考勤</button>
        <button class="btn" data-goto="comm">💬 家校沟通</button>
      </div>
    </div>
    <div class="cards c4">
      ${statCard("🎒 今日出勤", st.length? okN+" / "+st.length : "未登记", "green", "应到 "+st.length+" 人")}
      ${statCard("📬 家长回执待确认", pend+" <small>份</small>", pend?"warn":"", "来自 "+receipts.length+" 条通知")}
      ${statCard("📈 最近考试 数学均分", mathAvg, "accent", lastExam?esc(lastExam.name):"暂无考试")}
      ${statCard("✅ 待办事项", todos.length+" <small>项</small>", todos?"danger":"", "按截止时间处理")}
    </div>
    ${recentChartPanels(cls)}
    <div class="grid-3">
      <div>
        ${panel("今日待办", todos.length? todos.map(t=>`<div class="comm-item"><b>${esc(t.text)}</b><div class="meta"><span>截止 ${esc(t.due)}</span><span class="link" data-td="${t.id}">标记完成</span></div></div>`).join("") : `<div class="empty"><span class="eico">🌤️</span>今日待办已清空，去「待办任务」添加新事项吧</div>`)}
        ${panel("家长回执状态", receipts.length? receipts.map(n=>`<div class="comm-item"><b>${esc(n.title)}</b>
            <div class="bar" style="margin:6px 0"><i style="width:${n.receipts.confirmed/n.receipts.total*100}%"></i></div>
            <div class="meta"><span>${n.receipts.confirmed}/${n.receipts.total} 已确认</span><span>${esc(n.date)}</span></div></div>`).join("") : `<div class="empty"><span class="eico">📮</span>还没有发布过通知</div>`)}
      </div>
      <div>
        ${panel("常用入口", `<div class="toolbar" style="margin:0">
            <button class="btn" data-goto="students">🎒 学生档案</button><button class="btn" data-goto="att_ht">📋 考勤管理</button>
            <button class="btn" data-goto="comm">💬 家校沟通</button><button class="btn" data-goto="scores">📈 成绩学情</button>
            <button class="btn" data-goto="seating">🪑 座位班务</button><button class="btn" data-goto="ainotice">🪄 AI通知</button>
            <button class="btn" data-goto="moral">⭐ 德育量化</button><button class="btn" data-goto="todos">✅ 待办任务</button></div>`)}
        ${panel("本地天气", `<div style="text-align:center;padding:10px">
          <div style="font-size:34px">⛅</div><div style="font-weight:700;font-size:16px;margin-top:2px">--℃</div>
          <div class="muted" style="margin-top:4px">天气服务需联网获取<br>不影响平台其他功能</div></div>`)}
        ${panel("最近沟通记录", state.comms.slice().reverse().slice(0,3).map(c=>`<div class="comm-item"><b>${esc(c.student)} · ${esc(c.subject)} · ${esc(c.way)}</b><div class="s muted">${esc(c.summary)}</div><div class="meta"><span>${esc(c.date)}</span></div></div>`).join("")||`<div class="empty"><span class="eico">💬</span>暂无沟通记录</div>`)}
      </div>
    </div>`;
  document.querySelectorAll("[data-goto]").forEach(b=>b.onclick=()=>navigate(b.dataset.goto));
  document.querySelectorAll("[data-td]").forEach(b=>b.onclick=()=>{
    const t = state.todos.find(x=>x.id===b.dataset.td); t.done=true; save(); toast("待办已完成"); PAGES.dash_ht();
  });
};

/* ---------- 班主任 · 学生档案 ---------- */
PAGES.students = function(){
  const wrap = $("#page-body");
  function render(){
    const kw = ($("#st-kw")?.value||"").trim();
    const tg = $("#st-tag")?.value||"";
    let list = state.students.filter(s=>s.cls===curCls());
    if(kw) list = list.filter(s=>[s.name,s.guardian,s.phone].some(v=>v.includes(kw)));
    if(tg) list = list.filter(s=>s.tags.includes(tg));
    const allTags = [...new Set(state.students.flatMap(s=>s.tags))];
    wrap.innerHTML = panel(`学生档案 <span class="muted">（${curCls()} · 共 ${list.length} 人）</span>`,
      `<div class="toolbar">
        <input id="st-kw" placeholder="搜索姓名/监护人/手机号" value="${esc(kw)}">
        <select id="st-tag"><option value="">全部标签</option>${allTags.map(t=>`<option ${t===tg?"selected":""}>${esc(t)}</option>`).join("")}</select>
        <button class="btn btn-primary" id="st-add">＋ 新增学生</button>
        <button class="btn" id="st-imp">Excel/CSV 导入</button>
        <button class="btn" id="st-exp">导出 CSV</button>
      </div>
      <div id="st-table">${tableHTML(["学号","姓名","性别","监护人","联系电话","标签","备注","操作"],
        list.map(s=>[s.id, `<b>${esc(s.name)}</b>`, s.gender, esc(s.guardian), esc(s.phone),
          s.tags.map(t=>`<span class="tag blue">${esc(t)}</span>`).join("")||`<span class="muted">—</span>`,
          esc(s.remark)||"—",
          `<span class="link" data-edit="${s.id}">编辑</span> <span class="link" style="color:var(--danger)" data-del="${s.id}">删除</span>`]),
        {rowClick:true})}</div>`, "", true);
    const rows = list;
    $("#st-kw").oninput = render; $("#st-tag").onchange = render;
    $("#st-exp").onclick = ()=>exportCSV("学生档案",["学号","姓名","性别","监护人","联系电话","标签","备注"],
      rows.map(s=>[s.id,s.name,s.gender,s.guardian,s.phone,s.tags.join("|"),s.remark]));
    $("#st-add").onclick = ()=>studentForm(null, render);
    $("#st-imp").onclick = ()=>importModal("学生导入模板（每行：姓名,性别,监护人,电话,标签|分隔）", (lines)=>{
      let n=0;
      lines.forEach(l=>{
        const [name,gender,guardian,phone,tags] = l.split(",").map(x=>x?.trim());
        if(name && !state.students.some(s=>s.cls===curCls()&&s.name===name)){
          state.students.push({id:uid("HT"),name,cls:curCls(),gender:gender||"男",guardian:guardian||"",phone:phone||"",tags:tags?tags.split("|"):[],remark:""});
          n++;
        }
      });
      save(); toast(`成功导入 ${n} 名学生（重复行已跳过）`); render();
    });
    wrap.querySelectorAll("[data-edit]").forEach(e=>e.onclick=()=>studentForm(state.students.find(s=>s.id===e.dataset.edit), render));
    wrap.querySelectorAll("[data-del]").forEach(e=>e.onclick=()=>{
      const s = state.students.find(x=>x.id===e.dataset.del);
      confirmBox(`确认删除学生「${s.name}」？关联成绩与档案记录将保留原始归属。`, ()=>{ state.students = state.students.filter(x=>x.id!==s.id); save(); toast("已删除"); render(); });
    });
  }
  render();
}
function studentForm(s, done){
  const isNew = !s;
  s = s||{name:"",gender:"男",guardian:"",phone:"",tags:[],remark:""};
  modal(isNew?"新增学生":"编辑学生", `<div class="form-grid">
    <label>姓名<input id="sf-name" value="${esc(s.name)}"></label>
    <label>性别<select id="sf-gender"><option ${s.gender==="男"?"selected":""}>男</option><option ${s.gender==="女"?"selected":""}>女</option></select></label>
    <label>监护人<input id="sf-guardian" value="${esc(s.guardian)}"></label>
    <label>联系电话<input id="sf-phone" value="${esc(s.phone)}"></label>
    <label class="full">标签（逗号分隔）<input id="sf-tags" value="${esc(s.tags.join(","))}"></label>
    <label class="full">备注<textarea id="sf-remark" rows="2">${esc(s.remark)}</textarea></label>
  </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
    const name = $("#sf-name").value.trim();
    if(!name){ toast("姓名必填", true); return false; }
    const obj = {name, gender:$("#sf-gender").value, guardian:$("#sf-guardian").value.trim(), phone:$("#sf-phone").value.trim(),
      tags:$("#sf-tags").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean), remark:$("#sf-remark").value.trim()};
    if(isNew) state.students.push({id:uid("HT"), cls:curCls(), ...obj});
    else Object.assign(s, obj);
    save(); toast("已保存"); done();
  }}]);
}
/* ================= 表格文件解析（离线、无第三方依赖） =================
   支持 .xlsx / .xlsm（ZIP + Deflate，用浏览器原生 DecompressionStream 解压）
   与 .csv / .txt（文本）；老式 .xls 二进制需联网组件兜底解析。
   统一入口 readTableGrid(file) → 二维数组（每行一个数组，0 基）。 */
const tblDec = new TextDecoder("utf-8");
function colIdxOf(letters){ let n=0; for(const ch of String(letters).toUpperCase()) n = n*26 + (ch.charCodeAt(0)-64); return n-1; }
async function inflateRawBytes(bytes){
  if(typeof DecompressionStream === "undefined")
    throw new Error("当前浏览器不支持直接读取 .xlsx，请在 Excel 中另存为「CSV UTF-8」后再导入");
  const st = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
/* 读取 ZIP 内所有条目：走中央目录，兼容带数据描述符的文件 */
async function unzipAll(buf){
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for(let i=buf.length-22; i>=Math.max(0, buf.length-66000); i--){
    if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error("不是有效的 xlsx 文件（未找到压缩目录）");
  const count = dv.getUint16(eocd+10, true);
  let p = dv.getUint32(eocd+16, true);
  const out = {};
  for(let i=0;i<count;i++){
    if(dv.getUint32(p, true) !== 0x02014b50) break;
    const method   = dv.getUint16(p+10, true);
    const compSize = dv.getUint32(p+20, true);
    const nameLen  = dv.getUint16(p+28, true);
    const extraLen = dv.getUint16(p+30, true);
    const cmtLen   = dv.getUint16(p+32, true);
    const localOff = dv.getUint32(p+42, true);
    const name = tblDec.decode(buf.subarray(p+46, p+46+nameLen));
    if(compSize > 0 && !/\/$/.test(name)){
      const ln = dv.getUint16(localOff+26, true), le = dv.getUint16(localOff+28, true);
      const start = localOff+30+ln+le;
      const raw = buf.subarray(start, start+compSize);
      try{ out[name] = method === 0 ? raw : await inflateRawBytes(raw); }catch(e){ /* 跳过解压失败的条目 */ }
    }
    p += 46+nameLen+extraLen+cmtLen;
  }
  return out;
}
function xmlDocOf(bytes){ return new DOMParser().parseFromString(tblDec.decode(bytes), "application/xml"); }
function xlsxSharedStrings(entries){
  const b = entries["xl/sharedStrings.xml"]; if(!b) return [];
  const doc = xmlDocOf(b);
  return Array.from(doc.getElementsByTagNameNS("*","si")).map(si=>
    Array.from(si.getElementsByTagNameNS("*","t")).map(t=>t.textContent).join(""));
}
/* 第一个工作表 → 二维数组 */
function xlsxGrid(entries){
  const path = Object.keys(entries).filter(p=>/^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a,b)=>(+a.replace(/\D/g,""))-(+b.replace(/\D/g,"")))[0];
  if(!path) throw new Error("Excel 中未找到工作表");
  return sheetGridOf(entries[path], xlsxSharedStrings(entries));
}
/* 任意工作表 XML → 二维数组（v37：从 xlsxGrid 抽出，供多表解析复用）
   注意：WPS 等工具生成的 xlsx，一行内往往只有首个单元格带 r 属性，
   其余 <c> 省略 r —— 此时按行内顺序推断列号，否则整表只剩第一列 */
function sheetGridOf(buf, shared){
  const doc = xmlDocOf(buf), grid = [];
  Array.from(doc.getElementsByTagNameNS("*","row")).forEach(row=>{
    const ri = (+row.getAttribute("r") || grid.length+1) - 1;
    const cells = []; let implicit = 0;
    Array.from(row.getElementsByTagNameNS("*","c")).forEach(c=>{
      const ref = c.getAttribute("r") || "";
      let ci;
      if(ref){ ci = colIdxOf(ref.replace(/\d+/g,"")); implicit = ci+1; }
      else { ci = implicit; implicit = ci+1; }
      const ty = c.getAttribute("t");
      let val = "";
      if(ty === "s"){ const v = c.getElementsByTagNameNS("*","v")[0]; if(v) val = shared[+v.textContent] ?? ""; }
      else if(ty === "inlineStr"){
        const is = c.getElementsByTagNameNS("*","is")[0];
        if(is) val = Array.from(is.getElementsByTagNameNS("*","t")).map(x=>x.textContent).join("");
      }else{ const v = c.getElementsByTagNameNS("*","v")[0]; if(v) val = v.textContent; }
      if(ci >= 0 && val !== "") cells[ci] = String(val).trim();
    });
    grid[ri] = cells;
  });
  return grid.map(r=>r||[]);
}
/* 全部工作表（按工作簿顺序）→ [{name, grid}]（v37 考试成绩导入） */
function xlsxGridAll(entries){
  const wbBuf = entries["xl/workbook.xml"];
  if(!wbBuf) throw new Error("Excel 缺少 workbook.xml，请在 Excel 中另存为 .xlsx 后重试");
  const shared = xlsxSharedStrings(entries);
  const rels = {};
  const relBuf = entries["xl/_rels/workbook.xml.rels"];
  if(relBuf) Array.from(xmlDocOf(relBuf).getElementsByTagNameNS("*","Relationship")).forEach(r=>{
    rels[r.getAttribute("Id")] = r.getAttribute("Target")||"";
  });
  const out = [];
  Array.from(xmlDocOf(wbBuf).getElementsByTagNameNS("*","sheet")).forEach(sh=>{
    const rid = sh.getAttribute("r:id") || sh.getAttribute("id") || "";
    let target = rels[rid] || "";
    if(!target) return;
    target = target.replace(/^\//, "");
    if(!/^xl\//i.test(target)) target = "xl/" + target;
    const buf = entries[target];
    if(buf) out.push({ name: sh.getAttribute("name") || ("Sheet"+(out.length+1)), grid: sheetGridOf(buf, shared) });
  });
  if(!out.length) throw new Error("Excel 中未找到工作表");
  return out;
}
/* CSV / TXT → 二维数组（支持双引号包裹与 "" 转义、逗号或制表符分隔） */
function csvGrid(text){
  const rows = []; let row = [], cur = "", q = false;
  text = String(text).replace(/^\uFEFF/, "");
  for(let i=0;i<text.length;i++){
    const ch = text[i];
    if(q){
      if(ch === '"'){ if(text[i+1] === '"'){ cur += '"'; i++; } else q = false; }
      else cur += ch;
    }else if(ch === '"') q = true;
    else if(ch === "," || ch === "\t"){ row.push(cur); cur = ""; }
    else if(ch === "\n"){ row.push(cur); rows.push(row); row = []; cur = ""; }
    else if(ch !== "\r") cur += ch;
  }
  if(cur !== "" || row.length){ row.push(cur); rows.push(row); }
  return rows.map(r=>r.map(c=>String(c).trim()));
}
/* 兜底：联网用 SheetJS 解析老式 .xls */
function cdnSheetGrid(file){
  return loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js").then(()=>
    new Promise((ok, no)=>{
      const r = new FileReader();
      r.onload = ()=>{ try{
        const wb = XLSX.read(r.result, {type:"array"});
        ok(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:false, defval:""}));
      }catch(e){ no(e); } };
      r.onerror = ()=>no(new Error("文件读取失败"));
      r.readAsArrayBuffer(file);
    })).catch(()=>{ throw new Error("老式 .xls 需联网解析，请在 Excel 中另存为 .xlsx 或 CSV 后再导入"); });
}
async function readTableGrid(file){
  const name = (file.name||"").toLowerCase();
  if(/\.(xlsx|xlsm)$/.test(name)) return xlsxGrid(await unzipAll(new Uint8Array(await file.arrayBuffer())));
  if(/\.(csv|txt)$/.test(name)) return csvGrid(await file.text());
  if(/\.xls$/.test(name)) return cdnSheetGrid(file);
  throw new Error("不支持的文件格式，请使用 .xlsx / .csv");
}
/* 多工作表文件 → [{name, grid}]（xlsx 解析全部工作表；csv/txt 视为单表）（v37） */
async function readTableSheets(file){
  const name = (file.name||"").toLowerCase();
  if(/\.(xlsx|xlsm)$/.test(name)) return xlsxGridAll(await unzipAll(new Uint8Array(await file.arrayBuffer())));
  if(/\.(csv|txt)$/.test(name)) return [{name:(file.name||"成绩表").replace(/\.(csv|txt)$/i,""), grid:csvGrid(await file.text())}];
  throw new Error("考试成绩导入请使用 .xlsx 或 .csv 文件（老式 .xls 请先在 Excel 中另存为 .xlsx）");
}
function importModal(tip, onLines){
  modal("批量导入", `<p class="muted" style="margin-bottom:8px">${esc(tip)}</p>
    <input type="file" id="imp-file" accept=".csv,.txt,.xlsx,.xls" style="margin-bottom:8px">
    <textarea id="imp-text" rows="9" style="width:100%" placeholder="也可直接粘贴文本，每行一条"></textarea>`,
    [{text:"取消"},{text:"开始导入",cls:"btn-primary",fn:()=>{
      let text = $("#imp-text").value;
      const f = $("#imp-file").files[0];
      if(f){
        const name = f.name.toLowerCase();
        if(/\.(xlsx|xlsm|xls)$/.test(name)){
          toast("⏳ 正在解析 Excel…");
          readTableGrid(f).then(grid=>
            doImport(grid.map(r=>r.map(c=>String(c??"").trim()).join(",")).join("\n"))
          ).catch(e=>toast("Excel 解析失败："+e.message, true));
          return false;
        }
        const r = new FileReader(); r.onload = ()=>{ doImport(r.result); }; r.readAsText(f, "utf-8"); return false;
      }
      doImport(text);
    }}]);
  function doImport(text){
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
      .filter(l=>!/^(姓名|name)/i.test(l));
    if(!lines.length){ toast("没有可导入的数据", true); return; }
    onLines(lines);
  }
}

/* ---------- 班主任 · 班级档案 ---------- */
PAGES.classinfo = function(){
  const t = state.tenant;
  const fields = [["学校",t.name],["班级",curCls()],["班主任",t.gradeTeacher],["学年",t.year],["学期",t.term],
    ["教室",t.room],["班级群",t.groupQ],["联系电话",t.phone]];
  $("#page-body").innerHTML = panel("班级档案", `
    <div class="form-grid">
      ${fields.map(([k,v],i)=>`<label>${k}<input data-cf="${i}" value="${esc(v)}" ${i===1?"disabled title='班级名称请通过顶栏「管理」新增或删除'":""}></label>`).join("")}
      <label>班训<textarea data-cf="8" rows="2">${esc(t.motto)}</textarea></label>
    </div>`, `<button class="btn btn-primary" id="ci-save">保存</button>`);
  $("#ci-save").onclick = ()=>{
    const inputs = document.querySelectorAll("[data-cf]");
    t.name = inputs[0].value; t.gradeTeacher = inputs[2].value; t.year = inputs[3].value;
    t.term = inputs[4].value; t.room = inputs[5].value; t.groupQ = inputs[6].value; t.phone = inputs[7].value;
    t.motto = inputs[8].value;
    save(); toast("班级档案已保存");
  };
};

/* ---------- 班主任 · 座位与班务 ---------- */
PAGES.seating = function(){
  const wrap = $("#page-body");
  let sel = null;
  function render(){
    const se = state.seating;
    const byId = Object.fromEntries(state.students.map(s=>[s.id,s]));
    wrap.innerHTML =
      panel("座位表", `
        <div class="toolbar">
          行 <input id="se-r" type="number" value="${se.rows}" min="1" max="9" style="width:60px">
          列 <input id="se-c" type="number" value="${se.cols}" min="1" max="9" style="width:60px">
          <button class="btn" id="se-auto">自动排座</button>
          <button class="btn btn-primary" id="se-save">保存座位</button>
          <span class="muted">点选两个座位可交换</span>
        </div>
        <div class="seat-grid" style="grid-template-columns:repeat(${se.cols},1fr)">
          ${se.cells.map((id,i)=>{ const s = id?byId[id]:null;
            return `<div class="seat ${s?"":"empty-seat"}" data-seat="${i}" data-sid="${id||""}">${s?esc(s.name):"空"}${s&&s.tags.includes("班干部")?`<span class="post">班干部</span>`:""}</div>`;
          }).join("")}
        </div>`);
      $("#se-r").onchange = e=>{ se.rows = Math.min(9,Math.max(1,+e.target.value)); fix(); render(); };
      $("#se-c").onchange = e=>{ se.cols = Math.min(9,Math.max(1,+e.target.value)); fix(); render(); };
      $("#se-auto").onclick = ()=>{
        const ids = state.students.filter(s=>s.cls===curCls()).map(s=>s.id).sort(()=>Math.random()-0.5);
        se.cells = se.cells.map((_,i)=>ids[i]||null); sel=null; save(); toast("已自动排座（未保存原座位前可还原刷新）"); render();
      };
      $("#se-save").onclick = ()=>{ save(); toast("座位表已保存"); };
      wrap.querySelectorAll("[data-seat]").forEach(el=>el.onclick=()=>{
        const i = +el.dataset.seat;
        if(sel===null){ sel=i; el.classList.add("selected"); return; }
        if(sel===i){ sel=null; render(); return; }
        [se.cells[sel], se.cells[i]] = [se.cells[i], se.cells[sel]];
        sel=null; render();
      });
  }
  function fix(){
    const se = state.seating, n = se.rows*se.cols;
    while(se.cells.length<n) se.cells.push(null);
    se.cells = se.cells.slice(0,n);
  }
  function cadreRender(){
    const st = state.students.filter(s=>s.cls===curCls() && s.tags.includes("班干部"));
    wrap.insertAdjacentHTML("beforeend", panel("班干部管理", `
      <div class="toolbar">
        <select id="cd-sel">${state.students.filter(s=>s.cls===curCls()).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select>
        <input id="cd-post" placeholder="职务，如 班长/学习委员" style="width:160px">
        <button class="btn btn-primary" id="cd-add">新增/调整</button>
      </div>
      <div id="cd-table">${tableHTML(["姓名","职务","操作"], st.map(s=>[esc(s.name), esc(s.tags.filter(t=>t!=="班干部")[0]||"班干部"),
        `<span class="link" style="color:var(--danger)" data-cdd="${s.id}">移除</span>`]), {noSort:true})}</div>`));
    $("#cd-add").onclick = ()=>{
      const s = state.students.find(x=>x.id===$("#cd-sel").value);
      const post = $("#cd-post").value.trim()||"班干部";
      s.tags = s.tags.filter(t=>t!=="班干部" && !["班长","学习委员","体育委员","文艺委员","劳动委员"].includes(t));
      s.tags.push("班干部", post); save(); toast(`${s.name} 已设为 ${post}`); PAGES.seating();
    };
    wrap.querySelectorAll("[data-cdd]").forEach(e=>e.onclick=()=>{
      const s = state.students.find(x=>x.id===e.dataset.cdd);
      confirmBox(`移除「${s.name}」的班干部职务？`, ()=>{ s.tags = s.tags.filter(t=>t!=="班干部"&&t!=="班长"&&t!=="学习委员"&&t!=="体育委员"&&t!=="文艺委员"&&t!=="劳动委员"); save(); toast("已移除"); PAGES.seating(); });
    });
  }
  render(); cadreRender();
};

/* ---------- 班主任 · 考勤管理 ---------- */
PAGES.att_ht = function(){
  const wrap = $("#page-body");
  function render(){
    const date = $("#at-date")?.value || todayStr();
    if(!state.attHT[date]) state.attHT[date] = {};
    const att = state.attHT[date];
    const st = state.students.filter(s=>s.cls===curCls());
    const cnt = t => st.filter(s=>att[s.id]===t).length;
    wrap.innerHTML =
      `<div class="cards c4">
        ${statCard("出勤", cnt("到课")+" 人","green")}
        ${statCard("请假", cnt("请假")+" 人","warn")}
        ${statCard("旷课", cnt("旷课")+" 人","danger")}
        ${statCard("未登记", (st.length-cnt("到课")-cnt("请假")-cnt("旷课"))+" 人")}
      </div>` +
      panel(`每日考勤 <span class="muted">${esc(curCls())}</span>`, `
        <div class="toolbar">
          <input id="at-date" type="date" value="${date}">
          <button class="btn" id="at-exp">导出 CSV</button>
          <span class="muted">点击状态按钮切换登记，异常登记自动留痕</span>
        </div>
        <div id="at-table">${tableHTML(["姓名","状态","登记时间","说明"],
          st.map(s=>{ const a = att[s.id]||"未登记";
            return [ `<b>${esc(s.name)}</b>`,
              `<button class="att-btn ${a==="到课"?"on-ok":""}" data-s="${s.id}" data-v="到课">到课</button>
               <button class="att-btn ${a==="请假"?"on-leave":""}" data-s="${s.id}" data-v="请假">请假</button>
               <button class="att-btn ${a==="旷课"?"on-absent":""}" data-s="${s.id}" data-v="旷课">旷课</button>`,
              a==="未登记"?"—":date+" 08:00", esc(s.remark)||"—" ];
          }), {noSort:true})}</div>`, "", true);
    $("#at-date").onchange = render;
    $("#at-exp").onclick = ()=>exportCSV("考勤_"+date, ["姓名","状态"], st.map(s=>[s.name, att[s.id]||"未登记"]));
    wrap.querySelectorAll("[data-v]").forEach(b=>b.onclick=()=>{
      const sid = b.dataset.s, v = b.dataset.v;
      att[sid] = att[sid]===v ? undefined : v;
      if(!att[sid]) delete att[sid];
      save(); render();
    });
  }
  render();
};

/* ---------- 班主任 · 德育量化 ---------- */
PAGES.moral = function(){
  const wrap = $("#page-body");
  const evalLib = ["主动帮助同学","课堂积极发言","值日认真负责","拾金不昧","作业优秀","礼貌待人","课堂纪律提醒","作业迟交","与同学争执"];
  function render(){
    const cls = curCls();
    const recs = state.morals.slice().sort((a,b)=>b.date.localeCompare(a.date));
    const rank = {};
    state.students.filter(s=>s.cls===cls).forEach(s=>rank[s.name]=0);
    recs.forEach(r=>{ if(rank[r.name]!=null) rank[r.name]+=r.points; });
    const ranked = Object.entries(rank).sort((a,b)=>b[1]-a[1]);
    wrap.innerHTML =
      `<div class="cards c3">
        ${statCard("表扬次数", recs.filter(r=>r.type==="表扬").length, "green")}
        ${statCard("提醒次数", recs.filter(r=>r.type==="提醒").length, "warn")}
        ${statCard("本月积分净变化", recs.filter(r=>r.date>="2026-12").reduce((a,b)=>a+b.points,0), "accent")}
      </div>
      <div class="grid-2">
      ${panel("德育记录", `
        <div class="toolbar">
          <select id="mo-stu">${state.students.filter(s=>s.cls===cls).map(s=>`<option>${esc(s.name)}</option>`).join("")}</select>
          <select id="mo-type"><option>表扬</option><option>提醒</option></select>
          <input id="mo-pts" type="number" value="3" style="width:70px" title="分值">
          <input id="mo-reason" placeholder="事由" style="width:170px">
          <button class="btn btn-primary" id="mo-add">登记</button>
        </div>
        <div class="toolbar" style="flex-wrap:wrap">${evalLib.map(e=>`<span class="tag" data-lib="${esc(e)}" style="cursor:pointer">${esc(e)}</span>`).join("")} <span class="muted">← 评价库快捷选择</span></div>
        <div>${recs.map(r=>`<div class="comm-item"><b>${esc(r.student)}</b>
          <span class="tag ${r.type==="表扬"?"green":"warn"}">${r.type} ${r.points>0?"+":""}${r.points}</span>
          <span class="muted">${esc(r.reason)}</span>
          <div class="meta"><span>${esc(r.date)}</span></div></div>`).join("")||`<div class="empty">暂无记录</div>`}</div>`)}
      ${panel("积分排行榜", tableHTML(["名次","学生","积分"], ranked.map(([n,p],i)=>
        [`#${i+1}`, esc(n), `<span class="${p>=0?"num-up":"num-down"}">${p>0?"+":""}${p}</span>`]), {noSort:true}), "", true)}
      </div>`;
    $("#mo-type").onchange = e=>{ $("#mo-pts").value = e.target.value==="表扬"?3:-2; };
    wrap.querySelectorAll("[data-lib]").forEach(t=>t.onclick=()=>{ $("#mo-reason").value = t.dataset.lib; });
    $("#mo-add").onclick = ()=>{
      const reason = $("#mo-reason").value.trim();
      if(!reason){ toast("请填写事由", true); return; }
      state.morals.push({id:uid("M"), date:todayStr(), student:$("#mo-stu").value, type:$("#mo-type").value,
        points:+$("#mo-pts").value, reason});
      save(); toast("已登记"); render();
    };
  }
  render();
};

/* ---------- 成绩与学情（班主任/任课共用） ---------- */
PAGES.scores = function(){
  const isHT = session.role==="headteacher";
  const scopeCls = isHT ? null : session.account==="teacher02" ? ["初二(3)班","初二(5)班"] : [];
  const wrap = $("#page-body");
  let exId = state.exams.length? state.exams[state.exams.length-1].id : null;
  let cls = isHT ? curCls() : (scopeCls[0]||"");
  function calc(ex, c){
    const sc = state.scores[ex][c]||{};
    const out = {};
    state.subjects.forEach(sub=>{
      const vals = Object.values(sc).map(r=>r[sub]).filter(v=>v!=null);
      const full = state.fulls[sub];
      if(!vals.length){ out[sub] = null; return; }
      out[sub] = { avg:+(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1), max:Math.max(...vals), min:Math.min(...vals),
        pass:+(vals.filter(v=>v>=full*0.6).length/vals.length*100).toFixed(1), exc:+(vals.filter(v=>v>=full*0.85).length/vals.length*100).toFixed(1) };
    });
    return out;
  }
  function render(){
    if(!state.exams.length || !exId){
      wrap.innerHTML = panel("考试管理", `
        <div class="empty"><span class="eico">📈</span>还没有考试记录<br><br>
        <button class="btn btn-primary" id="sc-new0">＋ 新建第一场考试</button>
        <p class="muted" style="margin-top:10px">创建考试后即可录入/导入成绩，系统将自动计算均分、及格率、进退步与学生曲线</p></div>`);
      $("#sc-new0").onclick = newExamModal;
      return;
    }
    if(!state.scores[exId]) state.scores[exId] = {};
    if(!state.scores[exId][cls]) state.scores[exId][cls] = {};
    const sc = state.scores[exId][cls]||{};
    const stats = calc(exId, cls);
    const prevExam = state.exams[state.exams.findIndex(e=>e.id===exId)-1];
    const prevStats = prevExam ? calc(prevExam.id, cls) : null;
    const kw = ($("#sc-kw")?.value||"").trim(), fSub = $("#sc-sub")?.value||"", fMin = parseFloat($("#sc-min")?.value);
    let st = state.students.filter(s=>s.cls===cls);
    const stuRows = st.map(s=>{
      const row = sc[s.name];
      const total = row ? state.subjects.reduce((a,sub)=>a+(row[sub]??0),0) : null;
      const hasAny = row && state.subjects.some(sub=>row[sub]!=null);
      return {s,row,total,hasAny};
    }).filter(x=>x.hasAny);
    stuRows.sort((a,b)=>(b.total??-1)-(a.total??-1));
    stuRows.forEach((x,i)=>x.rank=i+1);
    let show = stuRows.filter(x=>(!kw||x.s.name.includes(kw)));
    if(fSub) show = show.filter(x=>x.row[fSub]!=null && (isNaN(fMin)||x.row[fSub]>=fMin));
    // 曲线
    const curveStudent = window.__curveStu;
    let chart = "";
    if(curveStudent){
      const cSeries = state.subjects.map((sub,i)=>({
        name:sub, color:["#3d8bfd","#3fbf7f","#e0a63f","#9d7bd8"][i],
        data:state.exams.map(e=>state.scores[e.id][cls]?.[curveStudent]?.[sub]??null)
      })).filter(s=>s.data.some(v=>v!=null));
      chart = panel(`${esc(curveStudent)} · 成绩变化曲线（空成绩不连接，不按 0 处理）`, lineChart(state.exams.map(e=>e.name), cSeries, {yMax:100}));
    }
    const avgDelta = sub => prevStats&&prevStats[sub]&&stats[sub] ? (stats[sub].avg-prevStats[sub].avg).toFixed(1) : null;
    wrap.innerHTML =
      panel("考试管理", `
        <div class="toolbar">
          <select id="sc-ex">${state.exams.map(e=>`<option value="${e.id}" ${e.id===exId?"selected":""}>${esc(e.name)}（${esc(e.date)}）</option>`).join("")}</select>
          <select id="sc-cls">${(isHT?[curCls()]:scopeCls).map(c=>`<option ${c===cls?"selected":""}>${esc(c)}</option>`).join("")}</select>
          <button class="btn" id="sc-new">＋ 新建考试</button>
          <button class="btn" id="sc-imp">Excel 导入成绩</button>
          <button class="btn" id="sc-exp">导出 CSV</button>
          <span class="muted">数据范围：${esc(session.scope)}</span>
        </div>`) +
      panel("班级统计", `<div class="cards c5" style="grid-template-columns:repeat(${state.subjects.length},1fr)">
        ${state.subjects.map(sub=>{
          const s = stats[sub];
          if(!s) return statCard(sub, `<small>无有效成绩，已自动隐藏口径</small>`);
          const d = avgDelta(sub);
          return `<div class="stat-card accent"><div class="lab">${esc(sub)}（满分${state.fulls[sub]}）</div>
            <div class="val">${s.avg}<small> 均</small></div>
            <div class="muted" style="font-size:11px;margin-top:4px">最高 ${s.max} · 最低 ${s.min} · 及格 ${s.pass}% · 优秀 ${s.exc}%
            ${d!==null?` · <span class="${d>=0?"num-up":"num-down"}">较上次 ${d>0?"+":""}${d}</span>`:""}</div></div>`;
        }).join("")}</div>`) +
      panel("成绩明细", `
        <div class="toolbar">
          <input id="sc-kw" placeholder="按姓名搜索" value="${esc(kw)}">
          <select id="sc-sub"><option value="">全部科目</option>${state.subjects.map(s=>`<option ${s===fSub?"selected":""}>${esc(s)}</option>`).join("")}</select>
          <input id="sc-min" type="number" placeholder="分数≥" style="width:90px" value="${isNaN(fMin)?"":fMin}">
          <span class="muted">点击姓名查看曲线 · 表头点击排序</span>
        </div>
        <div id="sc-table">${tableHTML(["排名","姓名",...state.subjects.map(s=>esc(s)+"（/"+state.fulls[s]+"）"),"总分","进退步"],
          show.map(x=>{
            const prevTot = prevExam ? (()=>{ const pr = state.scores[prevExam.id][cls]?.[x.s.name]; return pr? state.subjects.reduce((a,s)=>a+(pr[s]??0),0):null; })() : null;
            const delta = prevTot!=null&&x.total!=null ? x.total-prevTot : null;
            return [x.rank, `<span class="link" data-stu="${esc(x.s.name)}"><b>${esc(x.s.name)}</b></span>`,
              ...state.subjects.map(sub=> x.row[sub]==null?`<span class="muted">—</span>`:x.row[sub]),
              x.total??"—",
              delta==null?`<span class="muted">首考</span>`:`<span class="${delta>=0?"num-up":"num-down"}">${delta>0?"↑ +":""}${delta}</span>`];
          }), {noSort:true})}</div>`, "", true) + chart;
    $("#sc-ex").onchange = e=>{ exId = e.target.value; window.__curveStu=null; render(); };
    $("#sc-cls").onchange = e=>{ cls = e.target.value; window.__curveStu=null; render(); };
    ["sc-kw","sc-sub","sc-min"].forEach(id=>{ const el = $("#"+id); el.oninput = el.onchange = render; });
    $("#sc-exp").onclick = ()=>exportCSV(`成绩_${cls}_${state.exams.find(e=>e.id===exId).name}`,
      ["排名","姓名",...state.subjects,"总分"], show.map(x=>[x.rank,x.s.name,...state.subjects.map(s=>x.row[s]??""),x.total??""]));
    $("#sc-new").onclick = newExamModal;
    $("#sc-imp").onclick = ()=>importModal(`导入格式（每行）：姓名,${state.subjects.join(",")}\n空成绩留空；超出满分或非法分数将被拒绝；重复姓名按更新处理。`, lines=>{
      const full = state.fulls; let ok=0, bad=[];
      lines.forEach(l=>{
        const parts = l.split(",").map(x=>x?.trim());
        const name = parts[0]; if(!name) return;
        const stu = st.find(s=>s.name===name);
        if(!stu){ bad.push(name+"（不在本班）"); return; }
        const row = sc[name] = sc[name]||{};
        state.subjects.forEach((sub,i)=>{
          const v = parts[i+1];
          if(v===""||v==null){ row[sub]=null; return; }
          const n = parseFloat(v);
          if(isNaN(n)||n<0||n>full[sub]){ bad.push(`${name}-${sub}:${v}`); return; }
          row[sub]=n;
        });
        ok++;
      });
      save(); toast(`导入完成：成功 ${ok} 行`+(bad.length?`，拒绝 ${bad.length} 项：${bad.slice(0,5).join("、")}`:"")); render();
    });
    wrap.querySelectorAll("[data-stu]").forEach(e=>e.onclick=()=>{
      window.__curveStu = e.dataset.stu===window.__curveStu ? null : e.dataset.stu;
      render();
    });
  }
  function newExamModal(){
    modal("新建考试", `<div class="form-grid">
      <label>考试名称<input id="ne-name" placeholder="如 期末考试"></label>
      <label>日期<input id="ne-date" type="date" value="${todayStr()}"></label>
      <label class="full muted">科目与满分沿用当前配置（${state.subjects.map(s=>s+" "+state.fulls[s]).join(" / ")}），导入时自动校验非法分数。</label>
    </div>`, [{text:"取消"},{text:"创建",cls:"btn-primary",fn:()=>{
      const name = $("#ne-name").value.trim(); if(!name){ toast("请填写名称",true); return false; }
      const id = uid("E");
      state.exams.push({id,name,date:$("#ne-date").value});
      state.scores[id] = {}; (isHT?[curCls()]:scopeCls).forEach(c=>{ state.scores[id][c]={}; });
      exId = id; save(); toast("🎉 考试已创建"); render();
    }}]);
  }
  render();
};

/* ================================================================
   v37 考试成绩分析
   导入任意结构的成绩工作簿（如「346-学校考试数据.xlsx」）：
   自动识别封面页（考试名称/考试时间）与学生成绩页（姓名+各科分数列），
   支持多场考试多次导入；点击学生姓名查看历次成绩、各科进退步与班级排名趋势。
================================================================ */
const EXAM_META_COLS = ["姓名","学校","学校名称","专业","考试专业","考试名称","考试时间","考试类型","班级","考号","学号","序号","备注","排名","名次"];
function examSheets(){ if(!Array.isArray(state.examSheets)) state.examSheets = []; return state.examSheets; }
function examSorted(){
  return examSheets().slice().sort((a,b)=> String(a.date||"").localeCompare(String(b.date||"")) || (a.savedAt||0)-(b.savedAt||0));
}
/* 名次：同一考试内（可限定班级）按总分降序，返回 {rank, of} */
function examRank(exam, name, cls, clsFilter){
  const grp = exam.rows.filter(r=> clsFilter? r.cls===clsFilter : true)
    .slice().sort((a,b)=> (b.total??-1e9)-(a.total??-1e9));
  const i = grp.findIndex(r=> r.name===name && (cls? r.cls===cls : true));
  return i<0? null : {rank:i+1, of:grp.length};
}
/* 上一场（按日期）该生出现过的考试记录，用于计算进退步 */
function examPrevRow(examId, name, cls){
  const list = examSorted(); const idx = list.findIndex(e=>e.id===examId);
  for(let i=idx-1; i>=0; i--){
    const r = list[i].rows.find(x=> x.name===name && (cls? (!x.cls || x.cls===cls) : true));
    if(r) return {exam:list[i], row:r};
  }
  return null;
}
/* 解析成绩工作簿 → {name, date, school, subjects, rows} */
async function parseExamWorkbook(file){
  const sheets = await readTableSheets(file);
  const meta = {name:"", date:"", school:""};
  sheets.forEach(s=>{
    if(meta.name || !s.grid.length) return;
    const head = (s.grid[0]||[]).map(c=>String(c||"").trim());
    if(!head.includes("考试名称")) return;
    const row = s.grid[1]||[];
    const gv = k => { const i = head.indexOf(k); return i>=0? String(row[i]??"").trim() : ""; };
    meta.name = gv("考试名称"); meta.school = gv("学校名称");
    const m = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.exec(gv("考试时间"));
    if(m) meta.date = m[0].replace(/[年月]/g,"-").replace(/-$/,"");
  });
  let found = null;
  for(const s of sheets){
    if(found) break;
    const ri = s.grid.findIndex(r=> r.map(c=>String(c||"").trim()).includes("姓名"));
    if(ri<0) continue;
    const head = (s.grid[ri]||[]).map(c=>String(c||"").trim());
    const nameI = head.indexOf("姓名");
    const clsI = head.findIndex(h=> h==="班级");
    let totI = -1; const subj = [];
    head.forEach((h,i)=>{
      if(i===nameI || !h || i===clsI || EXAM_META_COLS.includes(h)) return;
      if(/总分/.test(h)){ if(totI<0) totI=i; return; }
      subj.push({name:h, i});
    });
    if(subj.length<2) continue;
    const rows = [];
    for(let r=ri+1; r<s.grid.length; r++){
      const cells = s.grid[r]||[];
      const nm = String(cells[nameI]??"").trim();
      if(!nm) continue;
      const scores = {};
      subj.forEach(x=>{
        const raw = String(cells[x.i]??"").trim();
        if(raw===""){ scores[x.name]=null; return; }
        const v = parseFloat(raw.replace(/[^\d.\-]/g,""));
        scores[x.name] = isNaN(v)? null : v;
      });
      let total = totI>=0? (parseFloat(String(cells[totI]??"")) || null) : null;
      if(total==null){ const sv = Object.values(scores).filter(v=>v!=null); total = sv.length? +sv.reduce((a,b)=>a+b,0).toFixed(1) : null; }
      rows.push({name:nm, cls: clsI>=0? String(cells[clsI]??"").trim() : "", scores, total});
    }
    if(rows.length){
      const used = subj.map(x=>x.name).filter(nm2=> rows.some(r=> r.scores[nm2]!=null));
      found = { subjects:used, rows };
    }
  }
  if(!found) throw new Error("未找到学生成绩表：需要一个含「姓名」列且有两列以上成绩的工作表");
  const base = (file.name||"成绩表").replace(/\.[^.]+$/,"").replace(/^\d+-?/,"");
  return { name: meta.name || base, date: meta.date || todayStr(), school: meta.school, subjects: found.subjects, rows: found.rows };
}
/* 导入入口：解析 → 同名覆盖确认 → 落库 → 回调 */
async function examImportFile(file, onDone){
  toast("⏳ 正在解析成绩表…");
  let data;
  try{ data = await parseExamWorkbook(file); }
  catch(e){ toast("导入失败："+e.message, true); return; }
  if(!data.rows.length){ toast("导入失败：表中没有学生成绩行", true); return; }
  const commit = ()=>{
    const dupe = examSheets().find(e=>e.name===data.name);
    const rec = {id:uid("EX"), name:data.name, date:data.date, school:data.school, subjects:data.subjects, rows:data.rows, savedAt:Date.now(), source:file.name||""};
    if(dupe) Object.assign(dupe, rec, {id:dupe.id});
    else examSheets().push(rec);
    save();
    toast(dupe? `♻ 已更新「${data.name}」（${data.rows.length} 名学生）` : `✅ 导入成功：${data.name}（${data.rows.length} 名学生 / ${data.subjects.length} 科）`);
    if(onDone) onDone(dupe? dupe.id : rec.id);
  };
  if(examSheets().some(e=>e.name===data.name))
    confirmBox(`已存在同名考试「${data.name}」，重新导入将覆盖原成绩。继续吗？`, commit);
  else commit();
}

PAGES.examrec = function(){
  const wrap = $("#page-body");
  const canEdit = ["headteacher","subjectteacher","schooladmin"].includes(session.role);
  let cur = {mode:"list", examId:null, kw:"", cls:""};
  function render(){ cur.mode==="detail"? renderDetail() : renderList(); }
  function go(mode, examId){ cur = {mode, examId:examId||null, kw:"", cls:""}; render(); }
  const fnum = v => v==null? "—" : String(v);
  const deltaHTML = d => d==null? `<span class="muted">—</span>`
    : `<span class="${d>=0?"num-up":"num-down"}">${d>0?"↑ +":""}${d}</span>`;

  /* ---- 考试列表 ---- */
  function renderList(){
    const list = examSorted().slice().reverse();
    wrap.innerHTML =
      panel("考试成绩分析", `
        <div class="toolbar">
          ${canEdit? `<button class="btn btn-primary" id="ex-imp">📥 导入成绩表（.xlsx / .csv）</button>
          <input type="file" id="ex-file" accept=".xlsx,.xlsm,.csv" style="display:none">` : ""}
          <span class="muted">自动识别封面页（考试名称/时间）与成绩页（姓名+各科分数列）；同名考试再次导入 = 覆盖更新</span>
        </div>`) +
      panel(`已导入考试（${list.length}）`, list.length? tableHTML(["考试名称","考试日期","班级","学生数","科目数","导入时间","操作"],
        list.map(e=>{
          const clss = [...new Set(e.rows.map(r=>r.cls).filter(Boolean))];
          return [ `<b>${esc(e.name)}</b>${e.school?`<div class="muted" style="font-size:11px">${esc(e.school)}</div>`:""}`,
            esc(e.date||"—"),
            clss.length? esc(clss.join("、")) : `<span class="muted">未标注</span>`,
            e.rows.length, e.subjects.length,
            esc(new Date(e.savedAt||Date.now()).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})),
            `<span class="link" data-view="${e.id}">查看</span> · <span class="link" data-exp="${e.id}">导出</span>` +
            (canEdit? ` · <span class="link" data-del="${e.id}" style="color:var(--danger)">删除</span>` : "") ];
        }), {noSort:true})
        : `<div class="empty"><span class="eico">📊</span>还没有导入过成绩表<br><small>支持「学校考试数据.xlsx」这类含封面页+学生成绩页的多工作表文件</small></div>`);
    if(canEdit){
      $("#ex-imp").onclick = ()=>$("#ex-file").click();
      $("#ex-file").onchange = e=>{ const f = e.target.files[0]; e.target.value=""; if(f) examImportFile(f, id=>go("detail", id)); };
    }
    wrap.querySelectorAll("[data-view]").forEach(el=> el.onclick = ()=> go("detail", el.dataset.view));
    wrap.querySelectorAll("[data-exp]").forEach(el=> el.onclick = ()=>{
      const e = examSheets().find(x=>x.id===el.dataset.exp); if(!e) return;
      exportCSV(`成绩_${e.name}`, ["姓名","班级",...e.subjects,"总分"],
        e.rows.map(r=>[r.name, r.cls||"", ...e.subjects.map(s=>r.scores[s]??""), r.total??""]));
    });
    wrap.querySelectorAll("[data-del]").forEach(el=> el.onclick = ()=>{
      const e = examSheets().find(x=>x.id===el.dataset.del); if(!e) return;
      confirmBox(`删除考试「${e.name}」及其全部 ${e.rows.length} 条成绩？不可恢复。`, ()=>{
        state.examSheets = examSheets().filter(x=>x.id!==e.id); save(); toast("已删除"); render();
      });
    });
  }

  /* ---- 考试明细 ---- */
  function renderDetail(){
    const ex = examSheets().find(e=>e.id===cur.examId);
    if(!ex){ cur = {mode:"list"}; return renderList(); }
    const clss = [...new Set(ex.rows.map(r=>r.cls).filter(Boolean))];
    const kw = (cur.kw||"").trim(), cls = cur.cls||"";
    const rows = ex.rows
      .filter(r=> (!cls || r.cls===cls) && (!kw || r.name.includes(kw)))
      .slice().sort((a,b)=> (b.total??-1e9)-(a.total??-1e9));
    const totals = ex.rows.map(r=>r.total).filter(v=>v!=null);
    const avg = totals.length? (totals.reduce((a,b)=>a+b,0)/totals.length).toFixed(1) : "—";
    const hi = totals.length? Math.max(...totals) : "—";
    wrap.innerHTML =
      panel(`<span class="link" id="ex-back">← 返回考试列表</span>　<b>${esc(ex.name)}</b>（${esc(ex.date||"日期未标注")}）`, `
        <div class="toolbar">
          ${clss.length? `<select id="ex-cls"><option value="">全部班级</option>${clss.map(c=>`<option ${c===cls?"selected":""}>${esc(c)}</option>`).join("")}`:""}
          <input id="ex-kw" placeholder="按姓名搜索" value="${esc(kw)}">
          <button class="btn" id="ex-exp">导出 CSV</button>
          <span class="muted">名次按总分（${cls? "限 "+esc(cls) : "全考场"}）· 点击姓名查看个人学情</span>
        </div>`, "", true) +
      `<div class="cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
        ${statCard("参考人数", ex.rows.length)}
        ${statCard("平均总分", avg)}
        ${statCard("最高总分", fnum(hi))}
        ${statCard("科目数", ex.subjects.length, "", esc(ex.subjects.slice(0,6).join(" · ")+(ex.subjects.length>6?" …":"")))}
      </div>` +
      panel("成绩明细", tableHTML(
        ["名次","姓名","班级",...ex.subjects.map(s=>esc(s)),"总分","较上一场"],
        rows.map(r=>{
          const pk = examRank(ex, r.name, r.cls, cls);
          const prev = examPrevRow(ex.id, r.name, r.cls||"");
          const d = prev && prev.row.total!=null && r.total!=null ? +(r.total - prev.row.total).toFixed(1) : null;
          return [ pk? `<b>${pk.rank}</b><span class="muted">/${pk.of}</span>` : "—",
            `<span class="link" data-stu="${esc(r.name)}" data-cls="${esc(r.cls||"")}"><b>${esc(r.name)}</b></span>`,
            r.cls? esc(r.cls) : `<span class="muted">—</span>`,
            ...ex.subjects.map(s=> r.scores[s]==null? `<span class="muted">—</span>` : r.scores[s]),
            fnum(r.total),
            d==null? `<span class="muted">首考</span>` : deltaHTML(d) ];
        }), {noSort:true}));
    $("#ex-back").onclick = ()=>go("list");
    const elCls = $("#ex-cls"); if(elCls) elCls.onchange = e=>{ cur.cls = e.target.value; render(); };
    $("#ex-kw").oninput = e=>{ cur.kw = e.target.value; render(); };
    $("#ex-exp").onclick = ()=> exportCSV(`成绩_${ex.name}${cls?"_"+cls:""}`,
      ["名次","姓名","班级",...ex.subjects,"总分"],
      rows.map(r=>[ examRank(ex,r.name,r.cls,cls)?.rank ?? "", r.name, r.cls||"",
        ...ex.subjects.map(s=>r.scores[s]??""), r.total??"" ]));
    wrap.querySelectorAll("[data-stu]").forEach(el=> el.onclick = ()=> stuModal(el.dataset.stu, el.dataset.cls));
  }

  /* ---- 学生个人学情（跨考试） ---- */
  function stuModal(name, cls){
    let hits = examSorted().map(e=>({e, row: e.rows.find(r=> r.name===name && (cls? (!r.cls || r.cls===cls) : true))})).filter(h=>h.row);
    if(!hits.length) hits = examSorted().map(e=>({e, row: e.rows.find(r=> r.name===name)})).filter(h=>h.row);
    if(!hits.length){ toast("未找到该学生的考试记录", true); return; }
    const labels = hits.map(h=> h.e.name.length>12? h.e.name.slice(0,12)+"…" : h.e.name);
    const subjUnion = [];
    hits.forEach(h=>h.e.subjects.forEach(s=>{ if(!subjUnion.includes(s)) subjUnion.push(s); }));
    const totData = hits.map(h=>h.row.total);
    const pkList = hits.map(h=> examRank(h.e, h.row.name, h.row.cls, h.row.cls||""));
    const rankData = pkList.map(pk=> pk? pk.rank : null);
    const totVals = totData.filter(v=>v!=null);
    const totMax = Math.max(10, ...totVals.map(v=>Math.ceil(v*1.15)));
    const rankMax = Math.max(2, ...rankData.filter(v=>v!=null));
    const last = hits[hits.length-1], prev = hits.length>1? hits[hits.length-2] : null;
    const dTot = prev && last.row.total!=null && prev.row.total!=null ? +(last.row.total - prev.row.total).toFixed(1) : null;
    const lastPk = pkList[pkList.length-1];
    const clss = [...new Set(hits.map(h=>h.row.cls).filter(Boolean))];
    const subRows = subjUnion.map(s=>{
      const vals = hits.map(h=> h.row.scores[s]);
      let d = null;
      for(let i=vals.length-1; i>0; i--){ if(vals[i]!=null){ const p = vals[i-1]; if(p!=null){ d = +(vals[i]-p).toFixed(1); break; } } }
      return [ `<b>${esc(s)}</b>`, ...vals.map(v=> v==null? `<span class="muted">—</span>` : v), d==null? `<span class="muted">—</span>` : deltaHTML(d) ];
    });
    modal(`${esc(name)} · 个人学情`,
      `<div class="muted" style="margin-bottom:12px">班级：${clss.length? esc(clss.join("、")) : "未标注"} · 共参加 ${hits.length} 场考试（名次在同班同学内统计）</div>
      <div class="cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
        ${statCard("最新考试", `<span style="font-size:14px;line-height:1.35;word-break:break-all">${esc((last.e.name||"").slice(0,12))}</span>`, "", esc(last.e.date||""))}
        ${statCard("最新总分", fnum(last.row.total), "", dTot==null? "首考" : `较上场 ${deltaHTML(dTot)}`)}
        ${statCard("最新名次", lastPk? `${lastPk.rank} <small>/ ${lastPk.of}</small>` : "—")}
        ${statCard("参考场次", hits.length)}
      </div>
      ${panel("总分趋势", lineChart(labels, [{name:"总分", color:"#3d8bfd", data:totData}], {yMax:totMax}))}
      ${panel("班级排名趋势（数字越小名次越好）", lineChart(labels, [{name:"班级名次", color:"#e0a63f", data:rankData}], {yMax:rankMax}))}
      ${panel("各科成绩与进退步", tableHTML(["科目",...labels,"进退步"], subRows, {noSort:true}))}`,
      [{text:"关闭"}]);
  }

  render();
};

/* ---------- 班主任 · 家校沟通 ---------- */
PAGES.comm = function(){
  const wrap = $("#page-body");
  function render(){
    const kw = ($("#cm-kw")?.value||"").trim(), fSub = $("#cm-sub")?.value||"", fStu = $("#cm-stu")?.value||"";
    const from = $("#cm-from")?.value||"";
    const notices = state.notices.filter(n=>n.cls===curCls() &&
      (!kw||n.title.includes(kw)||n.body.includes(kw)) && (!from||n.date>=from));
    const homework = state.notices.filter(n=>n.cls===curCls() && n.type==="作业");
    const comms = state.comms.filter(c=>(!kw||c.summary.includes(kw))&&(!fSub||c.subject===fSub)&&(!fStu||c.student===fStu)&&(!from||c.date>=from))
      .slice().sort((a,b)=>b.date.localeCompare(a.date));
    const notifCard = n=>`<div class="comm-item"><b>${esc(n.title)}</b>
      <div class="s muted">${esc(n.body.slice(0,40))}…</div>
      <div class="meta"><span class="tag green">微信回复 ${n.receipts.confirmed}/${n.receipts.total}</span><span>${esc(n.date)}</span>
      <span class="link" data-wexp="${n.id}">导出回执</span></div></div>`;
    wrap.innerHTML =
      panel("筛选", `<div class="toolbar">
        <input id="cm-kw" placeholder="关键词" value="${esc(kw)}">
        <select id="cm-sub"><option value="">全部科目</option>${["数学","语文","英语","物理"].map(s=>`<option ${s===fSub?"selected":""}>${esc(s)}</option>`).join("")}</select>
        <select id="cm-stu"><option value="">全部学生</option>${state.students.filter(s=>s.cls===curCls()).map(s=>`<option ${s.name===fStu?"selected":""}>${esc(s.name)}</option>`).join("")}</select>
        <input id="cm-from" type="date" value="${from}" title="起始日期">
        <button class="btn btn-primary" id="cm-add">＋ 新增沟通记录</button>
        <button class="btn" id="cm-wexp">导出沟通记录 Word</button>
      </div>`) +
      `<div class="comm-grid">
        <div class="comm-col">${panel("信息通知", notices.filter(n=>n.type==="通知").map(notifCard).join("")||`<div class="empty">暂无</div>`)}</div>
        <div class="comm-col">${panel("作业通知", homework.map(notifCard).join("")||`<div class="empty">暂无</div>`)}</div>
        <div class="comm-col">${panel("沟通记录", comms.map(c=>`<div class="comm-item"><b>${esc(c.student)} · ${esc(c.subject)}</b>
          <span class="tag">${esc(c.way)}</span><div class="s muted">${esc(c.summary)}</div>
          <div class="meta"><span>${esc(c.date)}</span><span>${esc(c.teacher)}</span></div></div>`).join("")||`<div class="empty">暂无</div>`)}</div>
      </div>`;
    ["cm-kw","cm-sub","cm-stu","cm-from"].forEach(id=>{ const el=$("#"+id); el.oninput=el.onchange=render; });
    wrap.querySelectorAll("[data-wexp]").forEach(e=>e.onclick=()=>{
      const n = state.notices.find(x=>x.id===e.dataset.wexp);
      exportWord("回执_"+n.title, `<h2>${esc(n.title)}</h2><p>${esc(n.body)}</p>
        <p>发送时间：${esc(n.date)} · 渠道：企业微信家长群</p>
        <p>确认回执：${n.receipts.confirmed}/${n.receipts.total} 位家长已确认</p>
        <p>未确认名单（演示）：张一鸣、郑晓萌等 ${n.receipts.total-n.receipts.confirmed} 位家长</p>`);
    });
    $("#cm-wexp").onclick = ()=>exportWord("家校沟通记录_"+todayStr(),
      `<h2>家校沟通记录</h2>`+comms.map(c=>`<p><b>${esc(c.date)} ${esc(c.student)}（${esc(c.subject)}·${esc(c.way)}）</b>：${esc(c.summary)}</p>`).join(""));
    $("#cm-add").onclick = ()=>{
      modal("新增沟通记录", `<div class="form-grid">
        <label>学生<select id="cmf-stu">${state.students.filter(s=>s.cls===curCls()).map(s=>`<option>${esc(s.name)}</option>`).join("")}</select></label>
        <label>科目<select id="cmf-sub">${["数学","语文","英语","物理"].map(s=>`<option>${s}</option>`).join("")}</select></label>
        <label>方式<select id="cmf-way"><option>电话</option><option>面谈</option><option>企业微信</option><option>家访</option></select></label>
        <label>日期<input id="cmf-date" type="date" value="${todayStr()}"></label>
        <label class="full">沟通摘要<textarea id="cmf-sum" rows="3" placeholder="客观记录沟通内容，不写入评价性猜测"></textarea></label>
      </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
        const sum = $("#cmf-sum").value.trim(); if(!sum){ toast("请填写摘要",true); return false; }
        state.comms.push({id:uid("C"), date:$("#cmf-date").value, student:$("#cmf-stu").value, subject:$("#cmf-sub").value,
          way:$("#cmf-way").value, summary:sum, teacher:session.name});
        save(); toast("沟通记录已保存"); render();
      }}]);
    };
  }
  render();
};

/* ---------- AI 通知整理（规则化模板，不虚构事实） ---------- */
PAGES.ainotice = function(){
  $("#page-body").innerHTML =
    panel("AI 通知整理", `
      <div class="toolbar">
        <input id="ai-input" placeholder="输入原始通知要点，例如：下周四社会实践 带水壶 帽子 午餐 穿校服" style="flex:1;min-width:260px">
        <button class="btn btn-primary" id="ai-run">整理为家长版</button>
        <button class="btn" id="ai-wecom">企业微信设置</button>
      </div>
      <div id="ai-out"></div>
      <p class="muted" style="margin-top:8px">说明：本演示采用规则化模板整理，仅重排教师已输入的内容，不虚构、不补充任何事实；正式版中大模型仅接收去标识化上下文，输出需教师确认后发送。</p>`);
  $("#ai-run").onclick = ()=>{
    const raw = $("#ai-input").value.trim();
    if(!raw){ toast("请输入内容", true); return; }
    const items = raw.split(/[,，;；\s]+/).filter(Boolean);
    const head = items[0], rest = items.slice(1);
    const out = `<div class="panel-body" style="background:var(--panel2);border:1px solid var(--border2);border-radius:8px">
      <b>【家长通知】${esc(head)}</b>
      <p style="margin:8px 0">各位家长好：</p>
      <ul style="padding-left:20px">${rest.map(r=>`<li>${esc(r)}</li>`).join("")||`<li>${esc(head)}</li>`}</ul>
      <p>请家长知悉并配合，如有疑问请联系班主任。谢谢！</p>
      <p class="muted">—— ${esc(curCls())} 班主任 ${esc(session.name)} · ${todayStr()}</p></div>
      <div class="toolbar" style="margin-top:10px">
        <button class="btn btn-ok" id="ai-send">模拟发送到企业微信群</button>
        <button class="btn" id="ai-copy">复制文本</button>
      </div>`;
    $("#ai-out").innerHTML = out;
    $("#ai-send").onclick = ()=>{
      state.notices.push({id:uid("N"), type:"通知", title:head, body:$("#ai-out").innerText.slice(0,300), date:todayStr(),
        cls:curCls(), receipts:{confirmed:0,total:state.students.filter(s=>s.cls===curCls()).length}});
      save();
      modal("模拟发送（企业微信演示通道）", `<p>已通过演示通道发送到「${esc(state.tenant.groupQ)}」。</p>
        <p class="muted" style="margin-top:8px">真实环境中：凭据仅保存于服务端，家长通过受控链接/企业微信查看，回复将同步并按绑定关系回采到学生。</p>`);
      toast("已模拟发送，回执统计已创建");
    };
    $("#ai-copy").onclick = ()=>{ navigator.clipboard?.writeText($("#ai-out").innerText); toast("已复制"); };
  };
  $("#ai-wecom").onclick = ()=>modal("企业微信连接设置", `
    <div class="form-grid">
      <label class="full">连接状态<input value="${esc(state.settings.wecom)}" disabled></label>
      <label class="full muted">安全说明：企业微信凭据（corpid/secret）仅保存于服务端，绝不下发到前端；发送与回复同步均由服务端任务队列执行并留痕。</label>
    </div>`);
};

/* ---------- 通知与分享 ---------- */
PAGES.shares = function(){
  const wrap = $("#page-body");
  function render(){
    wrap.innerHTML = panel("定向分享授权", `
      <div class="toolbar">
        <button class="btn btn-primary" id="sh-add">＋ 新建分享</button>
        <button class="btn" id="sh-revoke">撤销所选</button>
      </div>
      ${tableHTML(["分享人","接收人","内容","权限","有效期","访问次数","状态"],
        state.shares.map(s=>[esc(s.from),esc(s.target),esc(s.content),esc(s.perm),esc(s.expires),s.visits,
          `<span class="tag ${s.status==="生效中"?"green":"red"}">${esc(s.status)}</span> <span class="link" data-rev="${s.id}">撤销</span>`]),
        {rowClick:true})}
      <p class="muted" style="margin-top:8px">规则：分享配置包含接收人、字段范围、只读/编辑/下载权限、有效期与撤销机制；查看、下载、转发尝试均写入审计日志；子分享不能扩大权限或延长原授权期限。</p>`);
    wrap.querySelectorAll("[data-rev]").forEach(e=>e.onclick=()=>{
      const s = state.shares.find(x=>x.id===e.dataset.rev);
      confirmBox(`撤销分享「${s.content} → ${s.target}」？链接将立即失效并记录审计日志。`, ()=>{
        s.status="已撤销"; save(); toast("已撤销并留痕"); render();
      });
    });
    $("#sh-add").onclick = ()=>{
      modal("新建分享授权", `<div class="form-grid">
        <label>接收人（家长/教师）<input id="sf2-target" placeholder="如：张一鸣家长"></label>
        <label>内容<input id="sf2-content" placeholder="如：期中数学成绩摘要"></label>
        <label>权限<select id="sf2-perm"><option>只读</option><option>查看+补充</option><option>查看+下载</option><option>编辑</option></select></label>
        <label>有效期至<input id="sf2-exp" type="date" value="2027-01-31"></label>
        <label>访问次数限制<input id="sf2-visit" type="number" value="20"></label>
        <label>访问密码<input id="sf2-pass" placeholder="可选，防枚举"></label>
      </div>`, [{text:"取消"},{text:"创建授权",cls:"btn-primary",fn:()=>{
        const t = $("#sf2-target").value.trim(), c = $("#sf2-content").value.trim();
        if(!t||!c){ toast("请填写接收人与内容",true); return false; }
        state.shares.push({id:uid("S"), from:session.name, target:t, content:c, perm:$("#sf2-perm").value,
          expires:$("#sf2-exp").value, visits:0, status:"生效中"});
        save(); toast("分享已创建（含随机令牌与次数限制）"); render();
      }}]);
    };
  }
  render();
};

/* ---------- 教育故事 ---------- */
PAGES.stories = function(){
  const wrap = $("#page-body");
  function render(){
    wrap.innerHTML = panel("教育故事", `
      <div class="toolbar"><button class="btn btn-primary" id="st2-add">＋ 新建故事</button>
      <span class="muted">分享前默认隐藏学生真实姓名与身份信息；AI 润色内容需教师确认并突出标记。</span></div>
      ${tableHTML(["标题","日期","班级","关联学生","公开范围","状态"],
        state.stories.map(s=>[esc(s.title),esc(s.date),esc(s.cls),esc(s.students),esc(s.scope),
          `<span class="tag ${s.status==="草稿"?"warn":"green"}">${esc(s.status)}</span>`]), {rowClick:true})}`);
    $("#st2-add").onclick = ()=>{
      modal("新建教育故事", `<div class="form-grid">
        <label class="full">标题<input id="stf-title"></label>
        <label>日期<input id="stf-date" type="date" value="${todayStr()}"></label>
        <label>状态<select id="stf-status"><option>草稿</option><option>已完成</option><option>已归档</option></select></label>
        <label class="full">事件背景 / 经过 / 处理方式 / 结果 / 反思<textarea id="stf-body" rows="6" placeholder="请客观记录，AI 仅可做提纲、润色与反思提问，不得虚构学生行为、对话或处理结果"></textarea></label>
      </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
        const t = $("#stf-title").value.trim(); if(!t){toast("请填写标题",true);return false;}
        state.stories.push({id:uid("ST"), title:t, date:$("#stf-date").value, cls:curCls(),
          students:"", status:$("#stf-status").value, scope:"仅本人", excerpt:$("#stf-body").value.slice(0,60)});
        save(); toast("已保存"); render();
      }}]);
    };
  }
  render();
};

/* ---------- 学生问题档案 ---------- */
PAGES.problems = function(){
  const wrap = $("#page-body");
  const statusTag = s => `<span class="tag ${{"待评估":"warn","处理中":"blue","观察中":"purple","已解决":"green","已归档":""}[s]||""}">${esc(s)}</span>`;
  function render(){
    wrap.innerHTML = panel("学生问题档案", `
      <div class="toolbar"><button class="btn btn-primary" id="pb-add">＋ 建档</button>
      <span class="muted">敏感字段需单独授权查看；下载受限并留痕；大模型仅可整理摘要，不自动诊断学生。</span></div>
      ${tableHTML(["学生","类型","严重程度","状态","发现来源","负责人","建档日期","操作"],
        state.problems.map(p=>[esc(p.student),esc(p.type),`<span class="tag ${p.level==="高"?"red":p.level==="中"?"warn":"green"}">${esc(p.level)}</span>`,
          statusTag(p.status),esc(p.found),esc(p.owner),esc(p.date),
          `<span class="link" data-pbv="${p.id}">时间轴</span>`]), {rowClick:true})}`);
    wrap.querySelectorAll("[data-pbv]").forEach(e=>e.onclick=()=>{
      const p = state.problems.find(x=>x.id===e.dataset.pbv);
      modal("问题跟进时间轴 · "+p.student, `
        <div class="timeline">
          <div class="tl-item"><b>${esc(p.date)} 建档</b><div class="muted">${esc(p.desc)}</div></div>
          <div class="tl-item"><b>原因分析与方案</b><div class="muted">${esc(p.plan)}</div></div>
          <div class="tl-item"><b>当前状态</b><div>${statusTag(p.status)} 负责人：${esc(p.owner)}</div></div>
        </div>`);
    });
    $("#pb-add").onclick = ()=>{
      const m = modal("新建问题档案", `<div class="form-grid">
        <label>学生<select id="pbf-stu">${state.students.filter(s=>s.cls===curCls()).map(s=>`<option>${esc(s.name)}</option>`).join("")}</select></label>
        <label>类型<select id="pbf-type"><option>学习习惯</option><option>情绪行为</option><option>同伴关系</option><option>家庭变故</option><option>其他</option></select></label>
        <label>严重程度<select id="pbf-level"><option>低</option><option>中</option><option>高</option></select></label>
        <label>状态<select id="pbf-status"><option>待评估</option><option>处理中</option><option>观察中</option></select></label>
        <label class="full">问题描述<textarea id="pbf-desc" rows="3"></textarea></label>
        <label class="full">解决方案与计划节点<textarea id="pbf-plan" rows="2"></textarea></label>
      </div>`, [{text:"取消"},{text:"建档（二次确认后生效）",cls:"btn-primary",fn:()=>{
        const d = $("#pbf-desc").value.trim(); if(!d){toast("请填写描述",true);return false;}
        confirmBox("确认建立学生问题档案？该档案为敏感记录，将按敏感级别控制查看范围。", ()=>{
          state.problems.push({id:uid("PB"), student:$("#pbf-stu").value, type:$("#pbf-type").value, level:$("#pbf-level").value,
            status:$("#pbf-status").value, found:"班主任", owner:session.name, date:todayStr(), desc:d, plan:$("#pbf-plan").value.trim()});
          save(); m.close(); toast("已建档"); PAGES.problems();
        });
        return false;
      }}]);
    };
  }
  render();
};

/* ---------- 待办任务 ---------- */
PAGES.todos = function(){
  const wrap = $("#page-body");
  function render(){
    const mine = state.todos.filter(t=>t.owner===session.role);
    wrap.innerHTML = panel("待办任务", `
      <div class="toolbar"><input id="td-text" placeholder="新增待办…" style="min-width:240px">
      <input id="td-due" type="date" value="${todayStr()}">
      <button class="btn btn-primary" id="td-add">添加</button></div>
      ${mine.length? mine.map(t=>`<div class="comm-item">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" class="chk" data-td="${t.id}" ${t.done?"checked":""}>
          <span style="${t.done?"text-decoration:line-through;color:var(--text3)":""}">${esc(t.text)}</span></label>
        <div class="meta"><span>截止 ${esc(t.due)}</span><span class="link" style="color:var(--danger)" data-tdd="${t.id}">删除</span></div>
      </div>`).join("") : `<div class="empty">暂无待办</div>`}`);
    $("#td-add").onclick = ()=>{
      const v = $("#td-text").value.trim(); if(!v){toast("请填写内容",true);return;}
      state.todos.push({id:uid("T"), text:v, due:$("#td-due").value, done:false, owner:session.role});
      save(); toast("已添加"); render();
    };
    wrap.querySelectorAll("[data-td]").forEach(c=>c.onchange=()=>{ const t=state.todos.find(x=>x.id===c.dataset.td); t.done=c.checked; save(); render(); });
    wrap.querySelectorAll("[data-tdd]").forEach(e=>e.onclick=()=>{
      confirmBox("删除该待办？", ()=>{ state.todos = state.todos.filter(x=>x.id!==e.dataset.tdd); save(); render(); });
    });
  }
  render();
};

/* ---------- 任课教师 · 工作台 ---------- */
PAGES.dash_st = function(){
  const today = new Date(); const wk = ["周日","周一","周二","周三","周四","周五","周六"][today.getDay()];
  const courses = Object.fromEntries(Object.entries(state.timetable[wk]||{}).filter(([,c])=>{ const o=ttCell(c); return o&&!o.cov; }));
  const myTodos = state.todos.filter(t=>t.owner==="subjectteacher"&&!t.done);
  const duty = state.duties.filter(d=>d.date>=todayStr());
  const weekN = Object.values(state.timetable).reduce((a,d)=>a+Object.values(d).filter(v=>{const o=ttCell(v);return o&&!o.cov;}).length,0);
  $("#page-body").innerHTML = `
    <div class="hero-greet">
      <h2>${greetWord()}，${esc(session.name)}。<span class="hl">课堂见。</span></h2>
      <p>今天（${wk}）${Object.keys(courses).length?("有 "+Object.keys(courses).length+" 节课："+Object.entries(courses).map(([p,c])=>p+" "+ttLabel(c)).join("、")):"没有排课，适合备课与批改作业"} · 本周共 ${weekN} 节课</p>
      <div class="toolbar" style="margin:14px 0 0">
        <button class="btn btn-primary" data-goto="timetable">🗓️ 我的课表</button>
        <button class="btn" data-goto="rollcall">🙋 课堂点名</button>
        <button class="btn" data-goto="notes">📓 学习笔记</button>
      </div>
    </div>
    <div class="cards c4">
      ${statCard("📚 今日课程", Object.keys(courses).length+" <small>节</small>","accent","按时进入课堂")}
      ${statCard("🗓️ 本周课时", weekN+" <small>节</small>","","全部记录在案")}
      ${statCard("✅ 待办事项", myTodos.length+" <small>项</small>", myTodos?"danger":"","截止前完成")}
      ${statCard("📢 近期监考/会议", duty.length+" <small>场</small>","warn","安排见详情")}
    </div>
    ${recentChartPanels(curCls())}
    <div class="grid-2">
      <div>
        ${panel(`今日课程（${wk}）`, Object.entries(courses).length? Object.entries(courses).map(([p,c])=>{
          const t = state.periodTimes?.[p];
          return `<div class="comm-item"><b>${esc(p)}</b>${t?`<span class="tt-time"> ${esc(t)}</span>`:""}　${esc(ttLabel(c))}</div>`;
        }).join("") : `<div class="empty"><span class="eico">🍵</span>今日无课，去「个人课表」导入或编辑课表</div>`)}
        ${panel("今日待办", myTodos.map(t=>`<div class="comm-item"><b>${esc(t.text)}</b><div class="meta"><span>截止 ${esc(t.due)}</span></div></div>`).join("")||`<div class="empty"><span class="eico">✅</span>暂无待办</div>`)}
      </div>
      <div>
        ${panel("工作量概览", tableHTML(["项目","数量"],
          [["本周课时",weekN],["授课班级",new Set(Object.values(state.timetable).flatMap(d=>Object.values(d).map(c=>{ const o=ttCell(c); return o&&!o.cov? o.cls:""; }).filter(Boolean))).size],
           ["监考（已登记）",state.duties.filter(d=>d.type==="监考").length],["教研会议（已登记）",state.duties.filter(d=>d.type==="会议").length]].map(r=>[r[0],r[1]]), {noSort:true}), "", true)}
        ${panel("近期安排", state.duties.slice().sort((a,b)=>a.date.localeCompare(b.date)).slice(0,4).map(d=>`<div class="comm-item">
          <span class="tag ${d.type==="监考"?"warn":d.type==="会议"?"blue":"green"}">${esc(d.type)}</span> ${esc(d.detail)}
          <div class="meta"><span>${esc(d.date)}</span></div></div>`).join("")||`<div class="empty"><span class="eico">📢</span>暂无监考/值班/会议安排</div>`)}
      </div>
    </div>`;
  document.querySelectorAll("[data-goto]").forEach(b=>b.onclick=()=>navigate(b.dataset.goto));
};

/* ---------- 任课教师 · 个人课表（支持导入识别） ---------- */
function loadScript(src){
  return new Promise((res,rej)=>{
    if(document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload=res; s.onerror=()=>rej(new Error("脚本加载失败："+src));
    document.head.appendChild(s);
  });
}
// 图片压缩为 dataURL（作业上传用，控制 localStorage 体积）
function compressImage(file, maxDim=1100){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const sc = Math.min(1, maxDim/Math.max(img.width,img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width*sc); cv.height = Math.round(img.height*sc);
        cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);
        res(cv.toDataURL("image/jpeg",0.72));
      };
      img.onerror = rej;
      img.src = r.result;
    };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
// 解析课表网格：grid = 二维字符串数组
function parseTimetableGrid(grid){
  const dayMap = {"周一":0,"周二":1,"周三":2,"周四":3,"周五":4,"星期一":0,"星期二":1,"星期三":2,"星期四":3,"星期五":4,"星期六":5,"周六":5,"周日":6,"星期日":6};
  const subjKw = ["语文","数学","英语","物理","化学","生物","政治","历史","地理","科学","体育","音乐","美术","信息","道法","劳动","心理","班会","自习","阅读","书法","编程"];
  const clsPat = /([初一二三四五六七八九高]*\s*[（(]?\d+[)）]?\s*班|[（(]?\d+[)）]?\s*班)/;
  const tt = {}, times = {};
  let header = -1, dayCols = null, maxDay = 0;
  // 1) 找表头行
  grid.forEach((row,i)=>{
    if(header>-1) return;
    const cols = {};
    row.forEach((c,ci)=>{ const t = String(c||"").trim().replace(/\s/g,"");
      for(const k in dayMap) if(t===k || t.startsWith(k)&&t.length<=k.length+1) { cols[ci]=dayMap[k]; break; } });
    if(Object.keys(cols).length>=3){ header=i; dayCols=cols; maxDay=Math.max(...Object.values(cols)); }
  });
  const norm = s => { const t = String(s||"").trim(); if(!t||/^[-—]+$/.test(t)) return null;
    // 分词解析：班级=含数字且以"班"结尾的词（避免 "24计算机1班" 被截成 "1班"）
    let cls = ""; const rest = [];
    t.split(/[\s·,，、;；]+/).filter(Boolean).forEach(tok=>{
      if(!cls && /\d/.test(tok) && /班$/.test(tok)) cls = tok; else rest.push(tok);
    });
    if(!cls){ const cm = t.match(clsPat); if(cm) cls = cm[1].replace(/\s/g,""); }
    const r2 = rest.join(" ");
    const subj = subjKw.find(k=>r2.includes(k));
    let course = "", room = "";
    if(subj){ course = subj; room = r2.split(subj).slice(1).join(subj).trim(); }
    else { course = rest[0]||t; room = rest.slice(1).join(" "); }
    if(room && (!/\d/.test(room) || room.length>12)) room = "";
    return {course:(course||"课程").slice(0,16), cls, room}; };
  const rows = header>-1 ? grid.slice(header+1) : grid;
  let lastPeriod = null;
  rows.forEach(row=>{
    // 节次 + 时间（首格）
    let period = null;
    const c0 = String(row[0]||"").trim();
    const pm = c0.match(/(第?\s*[0-9一二三四五六七八九十]+\s*节|早自习|晚自习|晨读|午休)/);
    if(pm) period = pm[1].replace(/\s/g,"").replace(/^第?/,"第").replace(/节$/,"节");
    if(!period){ const dm = c0.match(/^([0-9]{1,2}|[一二三四五六七八九十]{1,3})$/); if(dm) period = "第"+dm[1]+"节"; }
    const tm = c0.match(/([01]?\d[:：][0-5]\d)\s*[-—~至]?\s*([01]?\d[:：][0-5]\d)?/);
    if(tm && period) times[period] = (tm[1]+(tm[2]?"-"+tm[2]:"")).replace(/：/g,":");
    if(!period && c0 && !/[语数英物化]/.test(c0) && c0.length<=5 && /[0-9一二三四五六七八九十]|早|晚|晨/.test(c0)) period = c0;
    if(!period){ // 无节次行：若整行仅首格有内容则跳过；否则并入上一节次（OCR 常见断行）
      const hasBody = row.slice(1).some(c=>String(c||"").trim());
      if(!(hasBody && lastPeriod)) return;
      period = lastPeriod;
    }
    lastPeriod = period;
    row.forEach((cell,ci)=>{
      if(ci===0) return;
      let day = null;
      if(dayCols && dayCols[ci]!=null) day = dayCols[ci];
      else if(!dayCols && ci>=1 && ci<=5) day = ci-1;
      if(day==null) return;
      const parsed = norm(cell);
      if(!parsed) return;
      const dayName = ["周一","周二","周三","周四","周五","周六","周日"][day];
      tt[dayName] = tt[dayName]||{};
      tt[dayName][period] = parsed;
    });
  });
  return {tt, times};
}
/* 课表格子统一模型：{course,cls,room,span}；{cov:1} 为连堂被占格（兼容旧字符串 班级·科目） */
function ttCell(v){
  if(!v) return null;
  if(typeof v==="string"){ const a=v.split("·"); return {course:a.slice(1).join("·")||a[0]||"课程", cls:a[0]||"", room:"", span:1}; }
  if(v.cov) return {cov:1};
  return {course:v.course||"", cls:v.cls||"", room:v.room||"", span:Math.max(1,v.span|0)};
}
function ttLabel(c){
  const o = ttCell(c);
  if(!o||o.cov) return "";
  return (o.cls? o.cls+"·":"")+o.course+(o.room? " @"+o.room:"");
}
PAGES.timetable = function(){
  const wrap = $("#page-body");
  const days = ["周一","周二","周三","周四","周五"];
  function cellAt(d,p){ return ttCell((state.timetable[d]||{})[p]); }
  function setCell(d,p,cell){
    const day = state.timetable[d] = state.timetable[d]||{};
    const ps = state.periods, pi = ps.indexOf(p);
    const old = ttCell(day[p]); const oldSpan = (old&&!old.cov)? old.span:1;
    for(let i=1;i<oldSpan && pi+i<ps.length;i++) delete day[ps[pi+i]];   // 清除旧连堂占位
    if(!cell){ delete day[p]; return; }
    const span = Math.min(cell.span||1, ps.length-pi);
    day[p] = {...cell, span};
    for(let i=1;i<span;i++) day[ps[pi+i]] = {cov:1};
  }
  function weekN(){ return Object.values(state.timetable).reduce((a,d)=>a+Object.values(d).filter(v=>{const o=ttCell(v);return o&&!o.cov;}).length,0); }
  function render(){
    const ps = state.periods;
    wrap.innerHTML = panel("个人课表", `
      <div class="toolbar">
        <button class="btn btn-primary" id="tt-imp">📥 导入课表（Excel / 图片识别）</button>
        <button class="btn" id="tt-time">⚙️ 节次管理（增删/改名，如晚自习）</button>
        <button class="btn" id="tt-clear">🗑 清空课表</button>
        <button class="btn" id="tt-exp">导出课表</button>
        <span class="muted">点击格子填写 课程/班级/地点，可选连堂合并 · 共 ${weekN()} 节</span>
      </div>
      <div class="tt-grid" style="grid-template-columns:96px repeat(5,1fr)">
        <div class="tt-cell tt-head" style="grid-column:1;grid-row:1">节次/时间</div>
        ${days.map((d,i)=>`<div class="tt-cell tt-head" style="grid-column:${i+2};grid-row:1">${d}</div>`).join("")}
        ${ps.map((p,pi)=>{
          const row = pi+2;
          let h = `<div class="tt-cell tt-head" style="grid-column:1;grid-row:${row}">${esc(p)}${state.periodTimes?.[p]?`<small>${esc(state.periodTimes[p])}</small>`:""}</div>`;
          days.forEach((d,di)=>{
            const c = cellAt(d,p);
            if(!c){ h += `<div class="tt-cell" data-cell="${d}|${p}" style="grid-column:${di+2};grid-row:${row};cursor:pointer"></div>`; return; }
            if(c.cov) return;
            h += `<div class="tt-cell has-course" data-cell="${d}|${p}" style="grid-column:${di+2};grid-row:${row};cursor:pointer;${c.span>1?`grid-row-end:span ${c.span};z-index:1;`:""}" title="点击编辑">
              <b>${esc(c.course)}</b>${c.cls?`<small>${esc(c.cls)}</small>`:""}${c.room?`<small>📍${esc(c.room)}</small>`:""}${c.span>1?`<small>🔗 连堂${c.span}节</small>`:""}</div>`;
          });
          return h;
        }).join("")}
      </div>`);
    $("#tt-exp").onclick = ()=>{
      exportCSV("个人课表", ["节次","时间",...days],
        ps.map(p=>[p, state.periodTimes?.[p]||"", ...days.map(d=>{ const c=cellAt(d,p); return c&&!c.cov? ttLabel(c):""; })]));
    };
    $("#tt-imp").onclick = timetableImport;
    $("#tt-time").onclick = periodsModal;
    $("#tt-clear").onclick = ()=>confirmBox("确认清空整张课表？此操作不可恢复。", ()=>{ state.timetable={}; save(); toast("课表已清空"); render(); });
    wrap.querySelectorAll("[data-cell]").forEach(el=>el.onclick=()=>{
      const [d,p] = el.dataset.cell.split("|");
      const c = cellAt(d,p) || {course:"",cls:"",room:"",span:1};
      const ps2 = state.periods, pi = ps2.indexOf(p);
      const maxSpan = Math.min(4, ps2.length-pi);
      modal(`编辑课程 · ${d} ${p}`, `<div class="form-grid">
        <label>课程名<input id="tc-course" value="${esc(c.course||"")}" placeholder="如：数学"></label>
        <label>班级<input id="tc-cls" value="${esc(c.cls||"")}" placeholder="如：初二(3)班"></label>
        <label class="full">授课地点<input id="tc-room" value="${esc(c.room||"")}" placeholder="如：教学楼3栋201"></label>
        <label>连堂合并<select id="tc-span">${Array.from({length:Math.max(1,maxSpan)},(_,i)=>i+1).map(n=>`<option value="${n}" ${(c.span||1)===n?"selected":""}>${n===1?"不合并":`与下一节连堂（共${n}节）`}</option>`).join("")}</select></label>
        <label>本节时间<input id="tc-t" value="${esc(state.periodTimes?.[p]||"")}" placeholder="如 08:00-08:45"></label>
      </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
        const course=$("#tc-course").value.trim(), cls=$("#tc-cls").value.trim(), room=$("#tc-room").value.trim();
        const span=+$("#tc-span").value, t=$("#tc-t").value.trim();
        if(course||cls||room) setCell(d,p,{course:course||"课程",cls,room,span});
        else setCell(d,p,null);
        if(t){ (state.periodTimes=state.periodTimes||{})[p]=t; }
        save(); toast("已保存"); render();
      }}]);
    });
  }
  function periodsModal(){
    const ps = state.periods.slice();
    modal("节次管理 · 可添加晚自习等自定义节次", `
      <div id="pt-list">${ps.map((p,i)=>`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input class="pn-in" value="${esc(p)}" style="width:120px" placeholder="节次名称">
          <input class="pt-in" value="${esc(state.periodTimes?.[p]||"")}" style="flex:1" placeholder="时间，如 19:00-20:40">
          <button class="cn-mini warn" data-pdel title="删除此节次">${ic("x",13)}</button>
        </div>`).join("")}</div>
      <button class="cn-add no-print" id="pt-add" style="margin-top:2px">${ic("plus",12)} 添加节次</button>
      <p class="muted" style="margin-top:8px">重命名节次后，课表与考勤记录自动跟随迁移；删除节次会同时清除其课表内容。</p>`,
      [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
        const names=[...document.querySelectorAll("#pt-list .pn-in")].map(i=>i.value.trim());
        const times=[...document.querySelectorAll("#pt-list .pt-in")].map(i=>i.value.trim());
        const seen={}, newPs=[], renames=[];
        names.forEach((n,i)=>{ if(!n) return;
          let name=n, k=2; while(seen[name]) name=n+(k++); seen[name]=1;
          newPs.push(name);
          if(ps[i] && name!==ps[i]) renames.push([ps[i],name]);
          if(times[i]){ (state.periodTimes=state.periodTimes||{})[name]=times[i]; if(ps[i]&&name!==ps[i]) delete state.periodTimes[ps[i]]; }
        });
        if(!newPs.length){ toast("至少保留一个节次", true); return false; }
        renames.forEach(([o,nw])=>{
          Object.keys(state.timetable).forEach(dd=>{ const day=state.timetable[dd];
            if(day[o]!=null){ day[nw]=day[o]; delete day[o]; } });
          Object.keys(state.rollcall||{}).forEach(k=>{ const a=k.split("_");
            if(a[1]===o){ const nk=[a[0],nw,...a.slice(2)].join("_"); state.rollcall[nk]=state.rollcall[k]; delete state.rollcall[k]; } });
        });
        ps.forEach(o=>{ if(!newPs.includes(o)) Object.keys(state.timetable).forEach(dd=>delete state.timetable[dd][o]); });
        state.periods = newPs;
        save(); toast("✓ 节次已更新"); render();
      }}]);
    const bindDel = b=>{ b.onclick=()=>b.parentElement.remove(); };
    document.querySelectorAll("[data-pdel]").forEach(bindDel);
    $("#pt-add").onclick = ()=>{
      const div=document.createElement("div");
      div.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:8px";
      const n=document.querySelectorAll("#pt-list > div").length+1;
      div.innerHTML=`<input class="pn-in" value="第${n}节" style="width:120px"><input class="pt-in" value="" style="flex:1" placeholder="时间（可选）"><button class="cn-mini warn" data-pdel title="删除">${ic("x",13)}</button>`;
      $("#pt-list").appendChild(div);
      bindDel(div.querySelector("[data-pdel]"));
      div.querySelector(".pn-in").focus();
    };
  }
  function timetableImport(){
    modal("导入课表", `
      <div class="import-zone" id="imp-zone">
        <div style="font-size:34px;margin-bottom:6px">📥</div>
        <b>点击选择 或 拖拽文件到此处</b>
        <p class="muted" style="margin-top:6px">支持 Excel(.xlsx/.xls)、CSV、课表截图(.png/.jpg)<br>自动识别星期列、节次、上课时间与课程</p>
        <input type="file" id="tt-file" accept=".xlsx,.xls,.csv,.png,.jpg,.jpeg" style="display:none">
      </div>
      <div id="imp-status" class="muted" style="margin:10px 0 4px;font-size:12px"></div>
      <label style="font-size:12px;color:var(--text2);font-weight:600">识别结果预览（可直接修正文本后再解析）</label>
      <textarea id="imp-text" rows="7" style="width:100%;margin-top:4px" placeholder="每行一节课，例如：&#10;节次,周一,周二,周三,周四,周五&#10;第1节 08:00-08:45,初二(3)班·数学,语文,英语,数学,物理&#10;第2节 08:55-09:40,初二(5)班·数学,数学,语文,英语,化学"></textarea>`,
      [{text:"取消"},{text:"🔍 解析预览",cls:"",fn:()=>{ parseFromText($("#imp-text").value); return false; }},
       {text:"✅ 确认导入",cls:"btn-primary",fn:m=>{ applyParsed(m); }}]);
    const zone = $("#imp-zone"), fi = $("#tt-file");
    zone.onclick = ()=>fi.click();
    zone.ondragover = e=>{ e.preventDefault(); zone.classList.add("dragover"); };
    zone.ondragleave = ()=>zone.classList.remove("dragover");
    zone.ondrop = e=>{ e.preventDefault(); zone.classList.remove("dragover"); if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
    fi.onchange = ()=>{ if(fi.files[0]) handleFile(fi.files[0]); };
    const status = msg => { $("#imp-status").textContent = msg; };
    function handleFile(f){
      const name = f.name.toLowerCase();
      if(/\.(png|jpe?g|bmp|webp)$/.test(name)) return ocrImage(f);
      if(/\.(xlsx|xls)$/.test(name)) return readExcel(f);
      // csv / txt
      const r = new FileReader();
      r.onload = ()=>{ $("#imp-text").value = r.result; status("✅ 已读取 "+f.name+"，点击「解析预览」"); };
      r.readAsText(f,"utf-8");
    }
    function readExcel(f){
      status("⏳ 正在加载表格解析组件…");
      loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js").then(()=>{
        const r = new FileReader();
        r.onload = ()=>{
          try{
            const wb = XLSX.read(r.result, {type:"array"});
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:""});
            $("#imp-text").value = rows.map(r2=>r2.map(c=>String(c??"").replace(/[\t\r\n]/g," ").trim()).join(",")).join("\n");
            status("✅ Excel 解析完成，点击「解析预览」查看识别结果");
          }catch(e){ status("❌ Excel 解析失败："+e.message+"（可另存为 CSV 再试）"); }
        };
        r.readAsArrayBuffer(f);
      }).catch(()=>status("❌ 表格组件加载失败（需联网）。请将 Excel 另存为 CSV 后重新导入，或直接粘贴文本。"));
    }
    function ocrImage(f){
      status("⏳ 正在加载文字识别组件（首次约需数秒）…");
      loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js").then(()=>{
        status("⏳ 正在识别图片中的课表文字，请稍候…");
        Tesseract.recognize(f, "chi_sim", {logger: m=>{ if(m.status==="recognizing text") status("⏳ 识别中 "+Math.round(m.progress*100)+"%"); }})
          .then(({data})=>{
            $("#imp-text").value = data.text;
            status("✅ 图片识别完成——请检查下方文本（识别可能有误差），修正后点击「解析预览」");
          })
          .catch(e=>status("❌ 识别失败："+e.message+"。可手动把课表内容粘贴到文本框。"));
      }).catch(()=>status("❌ 识别组件加载失败（需联网）。可对照图片手动填写文本框。"));
    }
    function parseFromText(text){
      const grid = text.split(/\r?\n/).map(l=>l.split(/[,，\t]+|\s{2,}/).map(c=>c.trim())).filter(r=>r.some(c=>c));
      if(!grid.length){ toast("没有可解析的内容", true); return; }
      const {tt, times} = parseTimetableGrid(grid);
      const days2 = ["周一","周二","周三","周四","周五"];
      const found = Object.values(tt).reduce((a,d)=>a+Object.keys(d).length,0);
      window.__ttPreview = {tt, times};
      const box = $("#imp-status");
      box.innerHTML = `识别到 <b style="color:var(--mint)">${found}</b> 节课、<b style="color:var(--mint)">${Object.keys(times).length}</b> 个节次时间。预览：<div class="tt-grid" style="margin-top:8px">
        <div class="tt-cell tt-head">节次</div>${days2.map(d=>`<div class="tt-cell tt-head">${d}</div>`).join("")}
        ${state.periods.slice(1).map(p=>`<div class="tt-cell tt-head">${p}${times[p]?`<small>${esc(times[p])}</small>`:""}</div>`+
          days2.map(d=>`<div class="tt-cell ${tt[d]?.[p]?"has-course":""}">${tt[d]?.[p]?esc(ttLabel(tt[d][p])):""}</div>`).join("")).join("")}</div>`;
      if(!found) toast("未识别出课程，请调整文本格式后重试", true);
    }
    function applyParsed(m){
      const pv = window.__ttPreview;
      if(!pv){ toast("请先点击「解析预览」", true); return false; }
      const found = Object.values(pv.tt).reduce((a,d)=>a+Object.keys(d).length,0);
      if(!found){ toast("没有可导入的课程", true); return false; }
      state.timetable = pv.tt;
      state.periodTimes = Object.assign({}, state.periodTimes, pv.times);
      save(); toast(`课表导入成功：共 ${found} 节课`);
      render();
    }
  }
  render();
};

/* ---------- 任课教师授课班级（班级管理 + 课表自动推导） ---------- */
function teacherClasses(){
  const set = new Set(allClasses());
  Object.values(state.timetable).forEach(d=>Object.values(d).forEach(c=>{ const o=ttCell(c); const cls=o&&!o.cov? o.cls.trim():""; if(cls) set.add(cls); }));
  return [...set].length? [...set] : ["我的班级"];
}

/* ---------- 任课教师 · 学生考勤（选课程/节次 · 保存入表 · 按月导出） ---------- */
/* 考勤页数据口径：课程=账号「学科」字段拆分；班级=账号「负责班级」字段拆分（均由超管维护） */
function myUser(){
  return state.users.find(u=>u.account===session.account && u.role===session.label);
}
function splitMulti(s){
  // 支持分隔符：、 ， , ; ; / ／ | 空格；含"与"且一侧有英文字母时再按"与"拆（如 计算机基础与Python）
  const parts = String(s||"").split(/[、，,;；\/／|]+|\s+/).map(x=>x.trim()).filter(Boolean);
  const out = [];
  parts.forEach(t=>{
    const m = t.split("与");
    if(m.length===2 && m[0].trim() && m[1].trim() && /[A-Za-z]/.test(m[0]+m[1])) out.push(m[0].trim(), m[1].trim());
    else out.push(t);
  });
  return out.filter(Boolean);
}
function attClasses(){
  const mine = splitMulti(myUser()?.classes);
  return mine.length? mine : teacherClasses();
}
function rcParseKey(k){
  const a = k.split("_");
  return { date:a[0], period:a[1], cls:a[2], subject:a.slice(3).join("_") };
}
function subjectsFor(cls){
  const mine = splitMulti(myUser()?.subject);
  if(mine.length) return mine;             // 优先：账号学科（如 计算机基础与Python → 计算机基础 / Python）
  const set = new Set();
  Object.values(state.timetable||{}).forEach(day=>{
    Object.values(day||{}).forEach(v=>{
      const o = ttCell(v);
      if(o && !o.cov && o.cls===cls && o.course) set.add(o.course);
    });
  });
  if(!set.size && Array.isArray(state.subjects)) state.subjects.forEach(s=>set.add(s));
  if(!set.size) set.add("课程");
  return [...set];
}
PAGES.rollcall = function(){
  const wrap = $("#page-body");
  const classes = attClasses();
  const drafts = {};                       // k -> 未保存的点名草稿
  let jump = null;                         // 由汇总表「修改」设置：定位到某条历史记录
  const key = (d,p,c,s)=>`${d}_${p}_${c}_${s}`;
  function getDraft(k){ return drafts[k] || (drafts[k] = {...(state.rollcall[k]||{})}); }
  function sessionRow(kk){
    const i = rcParseKey(kk), r = state.rollcall[kk];
    const n = t=>Object.values(r).filter(v=>v===t).length;
    const tot = n("到课")+n("请假")+n("旷课");
    return [i.date, esc(i.period), esc(i.cls||"—"), esc(i.subject||"—"),
      `<span class="tag green">${n("到课")}</span>`,
      `<span class="tag warn">${n("请假")}</span>`,
      `<b style="color:var(--danger)">${n("旷课")}</b>`,
      `<span class="muted" style="font-size:11px">${tot?(n("到课")/tot*100).toFixed(0)+"%":"—"}</span>`,
      `<span class="link" data-rcv="${esc(kk)}">查看</span> <span class="link" data-rcedit="${esc(kk)}">修改</span> <span class="link" style="color:var(--danger)" data-rcdel="${esc(kk)}">删除</span>`];
  }
  /* 查看：只读明细弹窗（到课 / 请假 / 旷课逐人列出） */
  function viewSession(kk){
    const i = rcParseKey(kk), r = state.rollcall[kk]; if(!r) return;
    const st = state.students.filter(s=>s.cls===i.cls);
    const n = t=>st.filter(s=>r[s.id]===t).length;
    const named = st.filter(s=>r[s.id]);
    const un = st.filter(s=>!r[s.id]).length;
    const tot = n("到课")+n("请假")+n("旷课");
    modal(`考勤明细 · ${i.date} ${i.period} ${i.cls||""} ${i.subject||""}`,
      `<div class="cards c3" style="margin-bottom:10px">
        ${statCard("到课", n("到课")+" 人","green", tot?(n("到课")/tot*100).toFixed(0)+"% 到课率":"—")}
        ${statCard("请假", n("请假")+" 人","warn")}
        ${statCard("旷课", n("旷课")+" 人", n("旷课")?"danger":"", un?("另有 "+un+" 人未点名"):"全部已点名")}
      </div>` + tableHTML(["姓名","学号","状态"],
        named.map(s=>[esc(s.name), esc(s.id||"—"),
          `<span class="tag ${r[s.id]==="到课"?"green":(r[s.id]==="请假"?"warn":"red")}">${esc(r[s.id])}</span>`]),
        {noSort:true}),
      [{text:"关闭"},{text:"修改此记录",cls:"btn-primary",fn:()=>gotoSession(kk)}]);
  }
  /* 修改：定位到该条记录，回到上方点名表继续编辑，保存即覆盖更新 */
  function gotoSession(kk){
    const i = rcParseKey(kk); if(!state.rollcall[kk]) return;
    jump = i; render();
    toast(`已定位到 ${i.date} ${i.period} · ${i.cls} ${i.subject}，修改后点「保存考勤记录」即可更新`);
  }
  /* 删除：二次确认后移除该条考勤记录 */
  function delSession(kk){
    const i = rcParseKey(kk), r = state.rollcall[kk]; if(!r) return;
    confirmBox(`删除考勤记录「${i.date} ${i.period} ${i.cls||""} ${i.subject||""}」（${Object.keys(r).length} 条点名数据）？此操作不可恢复。`, ()=>{
      delete state.rollcall[kk]; delete drafts[kk];
      save(); toast("考勤记录已删除"); render();
    });
  }
  /* 导出：按所选月份 / 年份（可叠加班级筛选）导出逐人明细 */
  function exportRc(ym, yr, cls){
    const rows = [];
    Object.keys(state.rollcall).sort().forEach(kk=>{
      const i = rcParseKey(kk);
      if(ym && !i.date.startsWith(ym)) return;
      if(yr && !i.date.startsWith(yr)) return;
      if(cls && i.cls!==cls) return;
      const r = state.rollcall[kk];
      state.students.filter(s=>s.cls===i.cls).forEach(s=>{
        if(r[s.id]) rows.push([i.date, i.period, i.cls||"", i.subject||"", s.name, r[s.id]]);
      });
    });
    if(!rows.length){ toast("所选范围暂无考勤记录", true); return; }
    exportCSV(`考勤记录_${cls||"全部班级"}_${ym||yr}`, ["日期","节次","班级","课程","姓名","状态"], rows);
  }
  function render(){
    /* 「修改」跳转：优先使用目标记录（只消费一次） */
    const jp = jump; jump = null;
    const d = jp?.date || $("#rc-date")?.value || todayStr();
    const p = jp?.period || $("#rc-period")?.value || state.periods[1] || state.periods[0] || "第1节";
    const c = jp?.cls || $("#rc-cls")?.value || (classes.includes(curCls())?curCls():(classes[0]||""));   // 班级联动顶栏切换
    const subs = subjectsFor(c);
    const sub0 = $("#rc-sub")?.value;
    const subj = jp?.subject || (subs.includes(sub0) ? sub0 : subs[0]);
    /* 历史记录的班级/节次/课程可能已不在候选里，补齐选项保证能显示 */
    const clsOpts = classes.includes(c)? classes : [c].concat(classes);
    const perOpts = state.periods.includes(p)? state.periods : [p].concat(state.periods);
    const subOpts = subs.includes(subj)? subs : [subj].concat(subs);
    const k = key(d,p,c,subj);
    const rec = getDraft(k);
    const saved = state.rollcall[k]||{};
    const dirty = JSON.stringify(rec)!==JSON.stringify(saved);
    const st = state.students.filter(s=>s.cls===c);
    const cnt = t=>st.filter(s=>rec[s.id]===t).length;
    const present = st.filter(s=>rec[s.id]==="到课").map(s=>s.name);
    const ym = $("#rc-month")?.value ?? "";
    const yr = $("#rc-year")?.value || "";
    const mCls = $("#rc-mcls")?.value || "";
    const years = [...new Set(Object.keys(state.rollcall).map(kk=>rcParseKey(kk).date.slice(0,4)))].sort().reverse();
    const curYr = String(new Date().getFullYear()); if(!years.includes(curYr)) years.push(curYr);
    const sessions = Object.keys(state.rollcall).filter(kk=>{
      const i = rcParseKey(kk);
      if(!Object.keys(state.rollcall[kk]).length) return false;
      if(ym && !i.date.startsWith(ym)) return false;
      if(yr && !i.date.startsWith(yr)) return false;
      return mCls==="" || i.cls===mCls;
    }).sort().reverse();
    const longSel = Object.keys(state.rollcall).some(kk=>Object.keys(state.rollcall[kk]).length>20);
    wrap.innerHTML =
      panel(`课时考勤 · 点名登记 <span class="muted">${esc(c)} · ${esc(subj)}</span>`, `
        <div class="toolbar">
          <input id="rc-date" type="date" value="${d}" title="上课日期">
          <select id="rc-period" title="节次（同一天可多次）">${perOpts.map(x=>`<option ${x===p?"selected":""}>${esc(x)}</option>`).join("")}</select>
          <select id="rc-cls" title="班级（来自账号管理 · 负责班级）">${clsOpts.map(x=>`<option ${x===c?"selected":""}>${esc(x)}</option>`).join("")}</select>
          <select id="rc-sub" title="课程（来自账号管理 · 学科，同一班级可带多门课）">${subOpts.map(x=>`<option ${x===subj?"selected":""}>${esc(x)}</option>`).join("")}</select>
          <span class="tag ${dirty?"warn":"green"}">${dirty?"● 未保存":"✓ 已存入考勤记录表"}</span>
          <button class="btn btn-primary" id="rc-save">💾 保存考勤记录</button>
        </div>
        <div class="toolbar">
          <button class="btn" id="rc-exp">导出本节 CSV</button>
          <button class="btn" id="rc-imp">导入 CSV</button>
          <button class="btn btn-ok" id="rc-lucky">🎲 随机点名（仅到课）</button>
        </div>
        <div class="cards c3" style="margin-bottom:10px">
          ${statCard("到课", cnt("到课")+" 人","green")}${statCard("请假", cnt("请假")+" 人","warn")}${statCard("旷课", cnt("旷课")+" 人","danger")}
        </div>
        <div id="rc-table">${tableHTML(["姓名","状态（点击切换，完成后点保存）","个人考勤记录"],
          st.map(s=>{ const a = rec[s.id]||"未点名";
            return [`<span class="link" data-rc="${s.id}"><b>${esc(s.name)}</b></span>`,
              `<button class="att-btn ${a==="到课"?"on-ok":""}" data-s="${s.id}" data-v="到课">到课</button>
               <button class="att-btn ${a==="请假"?"on-leave":""}" data-s="${s.id}" data-v="请假">请假</button>
               <button class="att-btn ${a==="旷课"?"on-absent":""}" data-s="${s.id}" data-v="旷课">旷课</button>`,
              `<span class="muted">点击姓名查看</span>`];
          }), {noSort:true})}</div>`, "", true) +
      `<div style="margin-top:14px">` +
      panel(`考勤汇总表 <span class="muted" style="font-size:12px">每条点名记录一行，支持查看 / 修改 / 删除，可按月 / 按年查询导出</span>`, `
        <div class="toolbar">
          <input id="rc-month" type="month" value="${ym}" title="按月查询">
          <select id="rc-year" title="按年查询"><option value="">全部年份</option>${years.map(y=>`<option ${y===yr?"selected":""}>${y}</option>`).join("")}</select>
          <select id="rc-mcls" title="按班级筛选"><option value="">全部班级</option>${classes.map(x=>`<option ${x===mCls?"selected":""}>${esc(x)}</option>`).join("")}</select>
          <button class="btn" id="rc-mexp">📤 按月导出 CSV</button>
          <button class="btn" id="rc-yexp">📤 按年导出 CSV</button>
          <span class="muted" style="font-size:12px">共 ${sessions.length} 条记录</span>
        </div>
        ${longSel?`<p class="muted" style="margin:-4px 0 8px">当前筛选范围记录较多，可叠加月份 / 年份 / 班级快速定位。</p>`:""}
        ${sessions.length ? tableHTML(["日期","节次","班级","课程","到课","请假","旷课","到课率","操作"],
          sessions.map(sessionRow), {noSort:true})
        : `<div class="empty" style="padding:24px"><span class="eico">🗓️</span>所选范围暂无考勤记录，点名后点击「保存考勤记录」即可存入</div>`}`, "", true) + `</div>`;
    ["rc-date","rc-period","rc-cls","rc-sub","rc-month","rc-year","rc-mcls"].forEach(id=>{ const el=$("#"+id); if(el) el.onchange=render; });
    wrap.querySelectorAll("[data-v]").forEach(b=>b.onclick=()=>{
      const sid=b.dataset.s, v=b.dataset.v;
      if(rec[sid]===v) delete rec[sid]; else rec[sid]=v;
      render();                                  // 只改草稿，不落库
    });
    $("#rc-save").onclick = ()=>{
      state.rollcall[k] = {...rec};
      delete drafts[k];
      save();
      toast(`✓ 已保存 ${d} ${p} ${subj} · ${Object.keys(rec).length} 条记录，已存入考勤记录表`);
      render();
    };
    wrap.querySelectorAll("[data-rc]").forEach(e=>e.onclick=()=>studentAttendance(e.dataset.rc));
    /* —— 汇总表操作：查看明细 / 修改（定位到该记录）/ 删除 —— */
    wrap.querySelectorAll("[data-rcv]").forEach(e=>e.onclick=()=>viewSession(e.dataset.rcv));
    wrap.querySelectorAll("[data-rcedit]").forEach(e=>e.onclick=()=>gotoSession(e.dataset.rcedit));
    wrap.querySelectorAll("[data-rcdel]").forEach(e=>e.onclick=()=>delSession(e.dataset.rcdel));
    $("#rc-exp").onclick = ()=>exportCSV(`点名_${c}_${d}_${p}_${subj}`, ["姓名","状态"], st.map(s=>[s.name, rec[s.id]||"未点名"]));
    $("#rc-imp").onclick = ()=>importModal("导入格式（每行）：姓名,状态（到课/请假/旷课）", lines=>{
      let n=0;
      lines.forEach(l=>{ const [name,stt] = l.split(",").map(x=>x?.trim());
        const stu = st.find(s=>s.name===name);
        if(stu && ["到课","请假","旷课"].includes(stt)){ rec[stu.id]=stt; n++; } });
      toast(`已导入 ${n} 条到草稿，请点击「保存考勤记录」入表`); render();
    });
    $("#rc-mexp").onclick = ()=>{
      const mv = $("#rc-month")?.value || "";
      if(!mv){ toast("请先选择要导出的月份", true); return; }
      exportRc(mv, "", $("#rc-mcls")?.value || "");
    };
    $("#rc-yexp").onclick = ()=>{
      const yv = $("#rc-year")?.value || String(new Date().getFullYear());
      exportRc("", yv, $("#rc-mcls")?.value || "");
    };
    $("#rc-lucky").onclick = ()=>{
      if(!present.length){ toast("本节尚无到课学生", true); return; }
      modal("随机点名", `<div class="roulette" id="lz">点击开始</div>`,
        [{text:"开始",cls:"btn-primary",fn:m=>{
          const lz = m.querySelector("#lz");
          let i = 0, n = 0;
          const timer = setInterval(()=>{
            lz.textContent = present[Math.floor(Math.random()*present.length)];
            if(++n > 24){ clearInterval(timer);
              const lucky = lz.textContent;
              lz.innerHTML = `${lucky}<div style="font-size:13px;color:var(--ok);margin-top:8px">✓ 已选中（到课学生池共 ${present.length} 人）</div>`;
              toast(`点到：${lucky}`);
            }
          }, 90);
          return false; // 不自动关闭
        }}]);
    };
  }
  render();
}
function studentAttendance(sid){
  const s = state.students.find(x=>x.id===sid);
  const rows = Object.keys(state.rollcall).sort().reverse().flatMap(k=>{
    const i = rcParseKey(k);
    if(i.cls!==s.cls || !state.rollcall[k][sid]) return [];
    return [[i.date, i.period, i.subject||"—", state.rollcall[k][sid]]];
  });
  const ok = rows.filter(r=>r[3]==="到课").length;
  modal(`${s.name} · 考勤记录`, `
    ${statCard("到课率", rows.length? (ok/rows.length*100).toFixed(0)+"%" : "—", "green")}
    <div style="margin-top:10px">${tableHTML(["日期","节次","课程","状态"], rows, {noSort:true})}</div>`);
}

/* ---------- 任课教师 · 积分功能 ---------- */
PAGES.points = function(){
  const wrap = $("#page-body");
  const classes = teacherClasses();
  function render(){
    const cls = $("#pt-cls")?.value||classes[0];
    const st = state.students.filter(s=>s.cls===cls);
    const totals = {};
    st.forEach(s=>totals[s.id]=0);
    state.points.filter(p=>p.cls===cls).forEach(p=>{ if(totals[p.studentId]!=null) totals[p.studentId]+=p.points; });
    const maxPt = Math.max(10, ...Object.values(totals));
    wrap.innerHTML =
      panel("课堂表现积分", `
        <div class="toolbar">
          <select id="pt-cls">${classes.map(c=>`<option ${c===cls?"selected":""}>${esc(c)}</option>`).join("")}</select>
          <span class="muted">填分值后点「＋加分」或「－减分」；减分需二次确认，每一笔记录后台全量保留</span>
        </div>
        <div id="pt-table">${tableHTML(["姓名","当前积分","积分进度","本次分值","操作"],
          st.map(s=>`<tr><td><b>${esc(s.name)}</b></td>
            <td><span class="${totals[s.id]<0?"num-down":"num-up"}" style="font-weight:700">${totals[s.id]}</span></td>
            <td style="min-width:140px"><div class="bar"><i style="width:${Math.max(0,totals[s.id])/maxPt*100}%"></i></div></td>
            <td><input data-pt="${s.id}" type="number" value="2" min="1" style="width:64px"></td>
            <td style="white-space:nowrap"><button class="btn btn-primary btn-sm" data-add="${s.id}">＋ 加分</button>
              <button class="btn btn-sm" data-sub="${s.id}" style="color:var(--danger);border-color:var(--danger)">－ 减分</button></td></tr>`),
          {noSort:true})}</div>
      <div style="margin-top:14px">${panel("积分流水（后台全量记录）", tableHTML(["日期","学生","分值","事由","教师"],
        state.points.filter(p=>p.cls===cls).slice().reverse().slice(0,20).map(p=>{
          const s = state.students.find(x=>x.id===p.studentId);
          return [p.date, esc(s?s.name:"?"), `<span class="${p.points<0?"num-down":"num-up"}">${p.points>0?"+":""}${p.points}</span>`, esc(p.reason||"课堂表现"), esc(p.teacher)];
        }), {noSort:true}))}</div>`);
    $("#pt-cls").onchange = render;
    function applyPt(sid, sign){
      const s = state.students.find(x=>x.id===sid);
      const v = +wrap.querySelector(`[data-pt="${sid}"]`).value;
      if(!s||!v||v<=0){ toast("分值需为正数", true); return; }
      const doIt = ()=>{
        state.points.push({id:uid("P"), date:todayStr(), cls, studentId:sid, points:sign*v, reason: sign>0?"课堂表现":"减分", teacher:session.name});
        save(); toast(sign>0?`⭐ 已为 ${s.name} 加 ${v} 分`:`已为 ${s.name} 减 ${v} 分`); render();
      };
      if(sign<0) confirmBox(`⚠️ 确认为 ${s.name} 减 ${v} 分？（将记入积分流水，学生端可见）`, doIt);
      else doIt();
    }
    wrap.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>applyPt(b.dataset.add,1));
    wrap.querySelectorAll("[data-sub]").forEach(b=>b.onclick=()=>applyPt(b.dataset.sub,-1));
  }
  render();
};

/* ---------- 任课教师 · 作业与练习 ---------- */
const HW_LEVELS = ["A+","A","A-","B+","B","B-","C"];
function hwSub(hwId, name){ return state.hws.find(x=>x.hwId===hwId && x.student===name); }
function hwMissed(cls, name){
  const subs = new Set(state.hws.filter(x=>x.cls===cls && x.student===name).map(x=>x.hwId));
  return state.homework.filter(h=>h.cls===cls && !subs.has(h.id)).length;
}
function hwMissCls(n){ return n>=3?"miss3":n===2?"miss2":""; }
PAGES.homework = function(){
  const wrap = $("#page-body");
  let tab = "list", curHw = null;
  function render(){
    const cls = curCls();
    const list = state.homework.filter(h=>h.cls===cls).sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
    const st = state.students.filter(s=>s.cls===cls);
    const subs = state.hws.filter(x=>x.cls===cls);
    const ungraded = subs.filter(x=>!x.level).length;
    const body = tab==="list" ? renderList(cls, list, st) : renderStatus(cls, list, st);
    wrap.innerHTML = `
      <div class="cards c4">
        ${statCard("📝 已发布作业", list.length+" <small>份</small>","accent")}
        ${statCard("📥 收到提交", subs.length+" <small>份</small>","green")}
        ${statCard("🖊 待批改", ungraded+" <small>份</small>", ungraded?"warn":"")}
        ${statCard("🎒 班级学生", st.length+" <small>人</small>")}
      </div>
      <div class="toolbar">
        <button class="btn ${tab==="list"?"btn-primary":""}" data-tab="list">作业列表</button>
        <button class="btn ${tab==="status"?"btn-primary":""}" data-tab="status">作业完成情况</button>
        <button class="btn btn-ok" id="hw-add">＋ 发布作业</button>
        <span class="muted">当前班级：${esc(cls)} · 学生提交后自动计入完成情况 · 缺交 2 次橙色 / 3 次及以上红色预警</span>
      </div>${body}`;
    wrap.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{ tab=b.dataset.tab; render(); });
    $("#hw-add").onclick = ()=>{
      const hwImgs = [];
      modal("发布作业", `<div class="form-grid">
        <label class="full">作业标题<input id="hwf-title" placeholder="如：数学练习册 P42 第1-8题"></label>
        <label>班级<select id="hwf-cls">${allClasses().map(c=>`<option ${c===cls?"selected":""}>${esc(c)}</option>`).join("")}</select></label>
        <label>截止/布置日期<input id="hwf-date" type="date" value="${todayStr()}"></label>
        <label class="full">作业说明<textarea id="hwf-desc" rows="3" placeholder="可选"></textarea></label>
        <div class="full">
          <div class="import-zone" id="hw-iz" style="cursor:pointer">
            <div style="font-size:26px">🖼️</div><b>添加作业图片（可选，可多选）</b>
            <p class="muted" style="margin-top:4px">如题目截图、练习页照片，学生端可点击放大查看</p>
          </div>
          <input type="file" id="hw-file" accept="image/*" multiple style="display:none">
          <div id="hw-img-prev" class="hw-imgs" style="margin-top:10px"></div>
        </div>
      </div>`, [{text:"取消"},{text:"发布",cls:"btn-primary",fn:()=>{
        const t = $("#hwf-title").value.trim();
        if(!t){ toast("请填写标题", true); return false; }
        state.homework.push({id:uid("HW"), title:t, cls:$("#hwf-cls").value, date:$("#hwf-date").value,
          desc:$("#hwf-desc").value.trim(), images:hwImgs, teacher:session.name});
        save(); toast("📝 作业已发布，学生端立即可见"); render();
      }}]);
      $("#hw-iz").onclick = ()=>$("#hw-file").click();
      $("#hw-file").onchange = async ()=>{
        const files = [...$("#hw-file").files];
        for(const f of files){
          try{ hwImgs.push(await compressImage(f)); }catch(e){}
        }
        if(files.length){
          $("#hw-img-prev").innerHTML = hwImgs.map((src,i)=>`<img src="${src}" data-i="${i}" style="cursor:zoom-in">`).join("");
          $("#hw-img-prev").querySelectorAll("img").forEach(el=>el.onclick=()=>imgViewer(hwImgs, +el.dataset.i));
          toast(`已添加 ${files.length} 张图片`);
        }
        $("#hw-file").value = "";
      };
    };
    bindList();
  }
  function renderList(cls, list, st){
    if(!list.length) return panel("作业列表", `<div class="empty"><span class="eico">📝</span>本班还没有发布过作业<br><span class="muted" style="font-size:11px">点击「＋ 发布作业」，学生在其学生端「作业与练习」中即可查看并上传提交</span></div>`);
    return panel(`作业列表 <span class="muted">${esc(cls)}</span>`, list.map(h=>{
      const got = state.hws.filter(x=>x.hwId===h.id).length;
      const graded = state.hws.filter(x=>x.hwId===h.id && x.level).length;
      return `<div class="comm-item"><b>${esc(h.title)}</b>
        <span class="tag blue">${esc(h.date)}</span><span class="muted">布置人 ${esc(h.teacher)}</span>
        ${h.desc?`<div class="s muted">${esc(h.desc)}</div>`:""}
        ${h.images&&h.images.length?`<div class="hw-imgs" style="margin-top:6px">${h.images.map((src,i)=>`<img src="${src}" data-hwhi="${i}" alt="作业图${i+1}">`).join("")}<span class="muted s" style="align-self:center">📎 附件 ${h.images.length} 张</span></div>`:""}
        <div class="meta"><span class="tag ${got>=st.length&&st.length?"green":""}">提交 ${got}/${st.length}</span><span>已批改 ${graded}</span>
        <span class="link" data-hwv="${h.id}">查看提交与批改 →</span></div></div>`;
    }).join("") || `<div class="empty">暂无</div>`, "", true);
  }
  function renderStatus(cls, list, st){
    if(!st.length) return panel("作业完成情况", `<div class="empty"><span class="eico">🎒</span>本班还没有学生，请先在顶栏「管理」中导入学生名单</div>`);
    return panel(`作业完成情况 <span class="muted">${esc(cls)}</span>`,
      tableHTML(["姓名","已提交","已批改","缺交","完成情况"],
        st.map(s=>{
          const my = state.hws.filter(x=>x.cls===cls && x.student===s.name);
          const miss = hwMissed(cls, s.name);
          return [`<b class="${hwMissCls(miss)}">${esc(s.name)}</b>`, my.length,
            my.filter(x=>x.level).length, miss>0?`<span class="num-down">${miss}</span>`:0,
            miss>=3?`<span class="tag red">⚠️ 缺交 ${miss} 次</span>`:miss===2?`<span class="tag warn">缺交 2 次</span>`:`<span class="tag green">正常</span>`];
        }), {noSort:true}), "", true);
  }
  function bindList(){
    wrap.querySelectorAll("[data-hwv]").forEach(e=>e.onclick=()=>openSubs(state.homework.find(h=>h.id===e.dataset.hwv)));
    wrap.querySelectorAll("[data-hwhi]").forEach(el=>el.onclick=()=>{
      const vid = el.closest(".comm-item").querySelector("[data-hwv]").dataset.hwv;
      const hw = state.homework.find(h=>h.id===vid);
      if(hw && hw.images) imgViewer(hw.images, +el.dataset.hwhi);
    });
  }
  function openSubs(hw){
    curHw = hw;
    const cls = hw.cls;
    const st = state.students.filter(s=>s.cls===cls);
    modal(`提交情况 · ${hw.title}（${cls}）`, `
      <div class="hw-cards">${st.map(s=>{
        const sub = hwSub(hw.id, s.name);
        const miss = hwMissed(cls, s.name);
        const cl = sub?"ok":hwMissCls(miss);
        return `<div class="hw-chip ${cl}" data-stu="${esc(s.name)}">
          <b>${esc(s.name)}</b>
          <small>${sub?(sub.level?`已批改 ${sub.level}`:"已提交"):(miss>=3?`缺交 ${miss} 次`:miss===2?"缺交 2 次":"未提交")}</small>
        </div>`;
      }).join("")||`<div class="empty">本班暂无学生</div>`}</div>
      <p class="muted" style="margin-top:8px">绿色 = 已提交；橙色 = 缺交 2 次；红色 = 缺交 3 次及以上。点击学生卡片查看作业图片并批改。</p>`,
      [{text:"关闭"}]);
    document.querySelectorAll("#modal-root [data-stu]").forEach(el=>el.onclick=()=>gradeModal(hw, el.dataset.stu));
  }
  function gradeModal(hw, name){
    const sub = hwSub(hw.id, name);
    if(!sub){
      const miss = hwMissed(hw.cls, name);
      modal(`${name} · ${hw.title}`, `<div class="empty"><span class="eico">⏳</span>该学生尚未提交这份作业</div>
        ${miss>=2?`<p class="muted">累计缺交 <b class="${hwMissCls(miss)}">${miss}</b> 次</p>`:""}`, [{text:"关闭"}]);
      return;
    }
    modal(`批改 · ${name} · ${hw.title}`, `
      <p class="muted">提交时间：${esc(sub.date)} ${esc(sub.time||"")} · 共 ${sub.images.length} 张</p>
      <div class="hw-imgs">${sub.images.map((src,i)=>`<img src="${src}" data-hwi="${i}" alt="作业${i+1}">`).join("")}</div>
      <div class="form-grid" style="margin-top:10px">
        <label>评分等级<select id="gf-level"><option value="">（暂不评分）</option>${HW_LEVELS.map(l=>`<option ${sub.level===l?"selected":""}>${l}</option>`).join("")}</select></label>
        <label class="full">评语（可不写）<textarea id="gf-cmt" rows="2" placeholder="如：过程完整，注意第3题单位换算">${esc(sub.comment||"")}</textarea></label>
      </div>`,
      [{text:"取消"},{text:"保存批改",cls:"btn-primary",fn:()=>{
        sub.level = $("#gf-level").value;
        sub.comment = $("#gf-cmt").value.trim();
        save(); toast(sub.level?`已评 ${sub.level}，学生端可见`:"已保存批改"); render();
      }}]);
    document.querySelectorAll("#modal-root [data-hwi]").forEach(el=>el.onclick=()=>imgViewer(sub.images, +el.dataset.hwi));
  }
  render();
};

/* ---------- 康奈尔笔记：统一线性图标（继承文字颜色，深浅色/打印自适应） ---------- */
const ICONS = {
  book:{n:"书本",p:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'},
  bulb:{n:"启发",p:'<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>'},
  note:{n:"笔记",p:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'},
  flow:{n:"流程",p:'<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>'},
  net:{n:"关系网",p:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>'},
  box:{n:"模块",p:'<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'},
  arrow:{n:"推导",p:'<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'},
  check:{n:"掌握",p:'<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'},
  star:{n:"重点",p:'<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'},
  target:{n:"目标",p:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'},
  help:{n:"提问",p:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'},
  flag:{n:"总结",p:'<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'},
  printer:{n:"打印",p:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'},
  plus:{n:"添加",p:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'},
  trash:{n:"删除",p:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'},
  image:{n:"插图",p:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'},
  table:{n:"表格",p:'<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>'},
  up:{n:"上移",p:'<polyline points="18 15 12 9 6 15"/>'},
  down:{n:"下移",p:'<polyline points="6 9 12 15 18 9"/>'},
  x:{n:"移除",p:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'},
};
const KBD_ICONS = ["book","bulb","note","flow","net","box","arrow","check","star","target"];
function ic(name, s=16){
  const d = ICONS[name]||ICONS.box;
  return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d.p}</svg>`;
}
function autoGrow(t){ if(!t) return; const f=()=>{ t.style.height="auto"; t.style.height=(t.scrollHeight+2)+"px"; }; t.addEventListener("input",f); f(); }
/* 旧版自由笔记 → 康奈尔结构 一次性迁移 */
function migrateNotes(){
  (state.notes||[]).forEach(n=>{
    if(n.blocks) return;
    const txt = (n.content||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    n.topic = n.title||"未命名课题"; n.cues = n.cues||[]; n.summary = n.summary||""; n.tags = n.tags||[];
    n.blocks = [{id:uid("B"), icon:"book", title:n.topic, text:txt, bullets:[], flow:[], table:null, img:"", boxes:[]}];
  });
}
/* ---------- 康奈尔笔记渲染（ro=只读/学生端） ---------- */
function kbBlockHTML(b, ro){
  const iconBtn = ro?`<span class="kb-ico" title="${ICONS[b.icon]?ICONS[b.icon].n:"模块"}">${ic(b.icon,16)}</span>`
    :`<button class="kb-ico" data-ico title="更换图标">${ic(b.icon,16)}</button>`;
  const bullets = (b.bullets||[]).length?`<ul class="kb-bullets">${b.bullets.map((x,i)=> ro
      ? `<li><span class="kb-dot">✓</span><span class="kb-bullet-ro">${esc(x)}</span></li>`
      : `<li><span class="kb-dot">✓</span><textarea class="kb-bullet-ta" rows="1" placeholder="要点…">${esc(x)}</textarea><button class="cn-mini warn no-print" data-bdel="${i}">${ic("x",12)}</button></li>`).join("")}</ul>`:"";
  const flow = (b.flow||[]).length?`<div class="kb-flow">${b.flow.map((s,i)=>{
      const chip = ro?`<span class="kb-step"><span class="kb-flow-ro">${esc(s)}</span></span>`
        :`<span class="kb-step"><input class="kb-flow-in" value="${esc(s)}" placeholder="步骤"><button class="cn-mini warn no-print" data-fdel="${i}">${ic("x",11)}</button></span>`;
      return (i?`<span class="kb-farrow">${ic("arrow",14)}</span>`:"")+chip;
    }).join("")}</div>`:"";
  const table = b.table?`<table class="kb-table"><thead><tr>${b.table.head.map((h,c)=> ro?`<th>${esc(h)}</th>`:`<th contenteditable="true" data-r="h" data-c="${c}">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${b.table.rows.map((row,r)=>`<tr>${row.map((cell,c)=> ro?`<td>${esc(cell)}</td>`:`<td contenteditable="true" data-r="${r}" data-c="${c}">${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    ${ro?"":`<div class="kb-addrow no-print"><button class="kb-addbtn" data-trow>${ic("plus",12)} 加行</button><button class="kb-addbtn" data-tcol>${ic("plus",12)} 加列</button><button class="kb-addbtn warn2" data-trdel>${ic("x",12)} 删末行</button><button class="kb-addbtn warn2" data-tcdel>${ic("x",12)} 删末列</button><button class="kb-addbtn warn2" data-tdel>${ic("trash",12)} 删表格</button></div>`}`:"";
  const boxes = (b.boxes||[]).length? b.boxes.map((x,i)=> ro
      ? (x?`<div class="kb-tbox"><p class="kb-tbox-ro">${esc(x)}</p></div>`:"")
      : `<div class="kb-tbox" data-bx="${i}"><textarea class="kb-tbox-ta" rows="2" placeholder="文本框：补充说明、公式、易错提醒…">${esc(x)}</textarea><button class="cn-mini warn no-print" data-bxdel="${i}" title="删除文本框">${ic("x",12)}</button></div>`).join("")
    :"";
  const img = b.img?`<img class="kb-img" src="${b.img}" ${ro?"":`data-iimg title="点击更换或删除插图"`}>`:"";
  const tools = ro?"":`
    <span class="kb-tools no-print">
      <button class="cn-mini" data-bup title="上移">${ic("up",14)}</button>
      <button class="cn-mini" data-bdown title="下移">${ic("down",14)}</button>
      <button class="cn-mini warn" data-bdel-block title="删除模块">${ic("trash",14)}</button>
    </span>`;
  const addrow = ro?"":`
    <div class="kb-addrow no-print">
      <button class="kb-addbtn" data-add="bullet">${ic("check",12)} 要点</button>
      <button class="kb-addbtn" data-add="flow">${ic("flow",12)} 流程/箭头</button>
      <button class="kb-addbtn" data-add="table">${ic("table",12)} 表格</button>
      <button class="kb-addbtn" data-add="textbox">${ic("box",12)} 文本框</button>
      <button class="kb-addbtn" data-add="img">${ic("image",12)} 插图</button>
    </div>`;
  return `<div class="kb-block" data-b="${b.id}">
    <div class="kb-head">${iconBtn}
      ${ro?`<h3 class="kb-title-ro">${esc(b.title||"知识点")}</h3>`:`<input class="kb-title" value="${esc(b.title||"")}" placeholder="知识点小标题，如：概念定义">`}
      ${tools}
    </div>
    <div class="kb-body">
      ${ro?`<p class="kb-text-ro">${esc(b.text||"")}</p>`:`<textarea class="kb-text" rows="2" placeholder="简要解释：这一知识点在讲什么？为什么重要？">${esc(b.text||"")}</textarea>`}
      ${bullets}${flow}${table}${boxes}${img}${addrow}
    </div>
  </div>`;
}
function cornellHTML(n, ro){
  const cues = n.cues||[], blocks = n.blocks||[];
  const cueHTML = cues.map((q,i)=> ro
    ? `<div class="cn-cue"><span class="cn-qno">Q${i+1}</span><p class="cn-cue-ro">${esc(q)}</p></div>`
    : `<div class="cn-cue" data-ci="${i}"><span class="cn-qno">Q${i+1}</span><textarea class="cn-cue-ta" rows="2" placeholder="针对右侧内容提问，复习时用它自测…">${esc(q)}</textarea><button class="cn-x no-print" data-cuedel="${i}" title="删除此问题">${ic("x",12)}</button></div>`).join("");
  return `<div class="cn-sheet" id="cn-sheet">
    <div class="cn-head">
      <div class="cn-head-l">
        <span class="cn-badge">${ic("book",13)} 康奈尔笔记</span>
        ${ro?`<h1 class="cn-topic">${esc(n.topic||"未命名课题")}</h1>`
            :`<input class="cn-topic" id="cn-topic" value="${esc(n.topic||"")}" placeholder="课题：如《二次函数的图像与性质》">`}
        <div class="cn-meta">📁 ${esc(n.book)} · 更新于 ${esc(n.updated||"—")}${(n.tags||[]).length?" · "+n.tags.map(t=>"#"+esc(t)).join(" "):""}
          ${ro?"":`<span id="cn-status" class="no-print">已保存 · ${esc(n.updated||"—")}</span>`}</div>
      </div>
      ${ro?"":`<div class="cn-head-r no-print">
        <button class="btn btn-sm" id="cn-print">${ic("printer",13)} 打印 / 导出PDF</button>
        <button class="btn btn-sm" id="cn-del" style="color:var(--danger)">${ic("trash",13)} 删除</button>
      </div>`}
    </div>
    <div class="cn-grid">
      <div class="cn-cues">
        <div class="cn-col-label">${ic("help",13)} 线索栏 · 提问</div>
        ${cueHTML || `<div class="cn-cue-hint">在这一栏写下问题，右侧记录知识。<br>复习时遮住右侧，用问题自测——这就是康奈尔笔记高效的原因。</div>`}
        ${ro?"":`<button class="cn-add no-print" id="cn-addcue">${ic("plus",12)} 添加问题</button>`}
      </div>
      <div class="cn-notes">
        <div class="cn-col-label">${ic("note",13)} 笔记栏 · 知识点模块</div>
        ${blocks.map(b=>kbBlockHTML(b,ro)).join("") || `<div class="cn-cue-hint">按知识点分模块记录：小标题 + 解释 + 要点 / 流程 / 表格 / 插图</div>`}
        ${ro?"":`<button class="cn-add no-print" id="cn-addblock">${ic("plus",12)} 添加知识点模块</button>`}
      </div>
    </div>
    <div class="cn-sum">
      <div class="cn-col-label">${ic("flag",13)} 总结栏 · 一页回顾</div>
      ${ro?`<p>${esc(n.summary||"（本页暂无总结）")}</p>`
          :`<textarea id="cn-sum" rows="3" placeholder="用 2~5 句话总结整页内容，考前只看这一栏就够了…">${esc(n.summary||"")}</textarea>`}
    </div>
  </div>`;
}
function iconPick(curId, fn){
  const m = modal("选择知识点图标", `<div class="ico-grid">${KBD_ICONS.map(k=>
    `<button class="ico-opt ${k===curId?"active":""}" data-k="${k}">${ic(k,20)}<span>${ICONS[k].n}</span></button>`).join("")}</div>`,
    [{text:"取消"}]);
  m.el.querySelectorAll(".ico-opt").forEach(b=>b.onclick=()=>{ fn(b.dataset.k); m.close(); });
}

/* ---------- 任课教师 · 康奈尔学习笔记 ---------- */
PAGES.notes = function(){
  const wrap = $("#page-body");
  migrateNotes();
  let openBooks = {};   // 笔记本展开状态
  let cur = state.notes.length? state.notes[state.notes.length-1].id : null;
  let tag = "";
  let imgTarget = null; // 插图上传的目标模块
  let dirty = false, autoT = null;
  const stamp = ()=> new Date().toLocaleString("zh-CN",{hour12:false}).replace(/\//g,"-");
  function markDirty(){ dirty=true; const st=$("#cn-status"); if(st) st.textContent="✍️ 编辑中…"; clearTimeout(autoT); autoT=setTimeout(saveNow,700); }
  function saveNow(){
    const n=state.notes.find(x=>x.id===cur); if(!n) return;
    n.updated=stamp(); dirty=false; save();
    const st=$("#cn-status"); if(st) st.textContent="已保存 · "+n.updated;
    refreshCounts();
  }
  function refreshCounts(){
    document.querySelectorAll("[data-bcnt]").forEach(el=>{ el.textContent = state.notes.filter(x=>x.book===el.dataset.bcnt).length; });
    const all = document.querySelector("[data-acnt]"); if(all) all.textContent = state.notes.length;
  }
  function books(){ return [...new Set(state.notes.map(n=>n.book))]; }
  function tags(){ return [...new Set(state.notes.flatMap(n=>n.tags))]; }
  function noteTitle(n){ return n.topic||n.title||"无标题"; }
  function matchKW(n,kw){
    if(!kw) return true;
    const hay=[n.topic,...(n.cues||[]),...(n.blocks||[]).map(b=>[b.title,b.text,(b.bullets||[]).join(" "),(b.flow||[]).join(" "),(b.table?JSON.stringify(b.table):"")].join(" ")),n.summary].join(" ");
    return hay.includes(kw);
  }
  /* —— 编辑态事件绑定：输入即写回模型，结构变更才重渲染 —— */
  function bindSheet(n){
    $("#cn-topic").oninput = e=>{ n.topic=e.target.value; markDirty(); };
    $("#cn-print").onclick = ()=>window.print();
    $("#cn-del").onclick = ()=>confirmBox(`删除笔记「${noteTitle(n)}」？`, ()=>{
      state.notes=state.notes.filter(x=>x.id!==n.id);
      cur=state.notes.length?state.notes[0].id:null; save(); toast("已删除"); render();
    });
    $("#cn-sum").oninput = e=>{ n.summary=e.target.value; markDirty(); }; autoGrow($("#cn-sum"));
    // 线索栏
    wrap.querySelectorAll(".cn-cue-ta").forEach(ta=>{
      ta.oninput=()=>{ n.cues[+ta.closest(".cn-cue").dataset.ci]=ta.value; markDirty(); }; autoGrow(ta);
    });
    wrap.querySelectorAll("[data-cuedel]").forEach(b=>b.onclick=()=>{ n.cues.splice(+b.dataset.cuedel,1); save(); render(); });
    $("#cn-addcue").onclick=()=>{ n.cues.push(""); save(); render();
      const tas=wrap.querySelectorAll(".cn-cue-ta"); if(tas.length){ tas[tas.length-1].focus(); autoGrow(tas[tas.length-1]); } };
    // 知识点模块
    wrap.querySelectorAll(".kb-block").forEach(el=>{
      const b=n.blocks.find(x=>x.id===el.dataset.b); if(!b) return;
      const bi=()=>n.blocks.indexOf(b);
      el.querySelector(".kb-title").oninput=e=>{ b.title=e.target.value; markDirty(); };
      const ta=el.querySelector(".kb-text"); ta.oninput=e=>{ b.text=e.target.value; markDirty(); }; autoGrow(ta);
      el.querySelectorAll(".kb-bullet-ta").forEach(t=>{ t.oninput=()=>{ b.bullets[+t.closest("li").querySelector("[data-bdel]").dataset.bdel]=t.value; markDirty(); }; autoGrow(t); });
      el.querySelectorAll("[data-bdel]").forEach(x=>x.onclick=()=>{ b.bullets.splice(+x.dataset.bdel,1); save(); render(); });
      el.querySelectorAll(".kb-flow-in").forEach((t,i)=>{ t.oninput=()=>{ b.flow[i]=t.value; markDirty(); }; });
      el.querySelectorAll("[data-fdel]").forEach(x=>x.onclick=()=>{ b.flow.splice(+x.dataset.fdel,1); save(); render(); });
      el.querySelectorAll("td[data-r]").forEach(td=>{
        td.oninput=()=>{ const r=td.dataset.r, c=+td.dataset.c;
          if(r==="h") b.table.head[c]=td.textContent.trim(); else b.table.rows[+r][c]=td.textContent.trim();
          markDirty(); };
      });
      const on=(sel,fn)=>{ const el2=el.querySelector(sel); if(el2) el2.onclick=fn; };
      on("[data-trow]",()=>{ b.table.rows.push(b.table.head.map(()=> "")); save(); render(); });
      on("[data-tcol]",()=>{ b.table.head.push("新列"); b.table.rows.forEach(r=>r.push("")); save(); render(); });
      on("[data-trdel]",()=>{ if(b.table.rows.length>1){ b.table.rows.pop(); save(); render(); } else toast("表格至少保留一行", true); });
      on("[data-tcdel]",()=>{ if(b.table.head.length>1){ b.table.head.pop(); b.table.rows.forEach(r=>r.pop()); save(); render(); } else toast("表格至少保留一列", true); });
      on("[data-tdel]",()=>{ b.table=null; save(); render(); });
      el.querySelectorAll(".kb-tbox-ta").forEach(t=>{ t.oninput=()=>{ b.boxes[+t.closest(".kb-tbox").dataset.bx]=t.value; markDirty(); }; autoGrow(t); });
      el.querySelectorAll("[data-bxdel]").forEach(x=>x.onclick=()=>{ b.boxes.splice(+x.dataset.bxdel,1); save(); render(); });
      on("[data-add=bullet]",()=>{ b.bullets.push(""); save(); render();
        const t=wrap.querySelectorAll(`.kb-block[data-b="${b.id}"] .kb-bullet-ta`); if(t.length){ t[t.length-1].focus(); autoGrow(t[t.length-1]); } });
      on("[data-add=flow]",()=>{ b.flow = b.flow.length? [...b.flow,"新步骤"] : ["步骤 1","步骤 2"]; save(); render(); });
      on("[data-add=table]",()=>{ b.table={head:["项目","说明"],rows:[["",""],["",""]]}; save(); render(); });
      on("[data-add=textbox]",()=>{ b.boxes=b.boxes||[]; b.boxes.push(""); save(); render();
        const t=wrap.querySelectorAll(`.kb-block[data-b="${b.id}"] .kb-tbox-ta`); if(t.length){ t[t.length-1].focus(); autoGrow(t[t.length-1]); } });
      on("[data-add=img]",()=>{ imgTarget=b; $("#cn-file").click(); });
      on("[data-iimg]",()=>{ imgTarget=b; $("#cn-file").click(); });
      el.querySelector(".kb-img")&&(el.querySelector(".kb-img").oncontextmenu=e=>{ e.preventDefault(); b.img=""; save(); render(); toast("已删除插图（右键移除）"); });
      on("[data-ico]",()=>iconPick(b.icon,k=>{ b.icon=k; save(); render(); }));
      on("[data-bup]",()=>{ const i=bi(); if(i>0){ n.blocks.splice(i-1,0,n.blocks.splice(i,1)[0]); save(); render(); } });
      on("[data-bdown]",()=>{ const i=bi(); if(i<n.blocks.length-1){ n.blocks.splice(i+1,0,n.blocks.splice(i,1)[0]); save(); render(); } });
      on("[data-bdel-block]",()=>confirmBox("删除该知识点模块？",()=>{ n.blocks.splice(bi(),1); save(); render(); }));
    });
    $("#cn-addblock").onclick=()=>{ n.blocks.push({id:uid("B"),icon:"bulb",title:"",text:"",bullets:[],flow:[],table:null,img:"",boxes:[]}); save(); render();
      const t=wrap.querySelector(".kb-block:last-of-type .kb-title"); if(t) t.focus(); };
    $("#cn-file").onchange = async e=>{
      const f=e.target.files[0]; e.target.value="";
      if(!f||!imgTarget) return;
      try{ imgTarget.img = await compressImage(f); save(); toast("🖼 插图已添加"); render(); }
      catch(err){ toast("图片处理失败",true); }
      imgTarget=null;
    };
  }
  function render(){
    const kw = ($("#nb-kw")?.value||"").trim();
    const n = state.notes.find(x=>x.id===cur);
    // 左侧树：全部笔记 + 笔记本（内联二级=笔记列表）+ 标签
    const sideHTML = `
      <div class="nb-tree-item ${!cur?"active":""}" data-all="1">🗂 全部笔记 <span class="cnt" data-acnt>${state.notes.length}</span></div>
      <div class="sec-title">笔记本 <span><span class="link" id="nb-rebook" title="重命名笔记本">✎</span> · <span class="link" id="nb-addbook">＋ 新建</span></span></div>
      ${books().map(b2=>{
        const bn = state.notes.filter(x=>x.book===b2 && matchKW(x,kw)).sort((a,b)=>(b.updated||"").localeCompare(a.updated||""));
        const open = openBooks[b2];
        return `<div class="nb-tree-item ${open?"open":""} ${cur&&bn.some(x=>x.id===cur)?"active":""}" data-book="${esc(b2)}">
            <span class="tw">▶</span>📁 ${esc(b2)} <span class="cnt" data-bcnt="${esc(b2)}">${bn.length}</span></div>
          ${open?`<div class="nb-sub">${bn.map(x=>`<div class="nb-sub-item ${x.id===cur?"active":""}" data-n="${x.id}" title="${esc(noteTitle(x))}">
              ${esc(noteTitle(x))}<div class="d">${esc(x.updated||"")}</div></div>`).join("")||`<div class="nb-sub-item muted">（无匹配笔记）</div>`}</div>`:""}`;
      }).join("")}
      <div class="sec-title">标签</div>
      <div class="tag-cloud" style="padding:0 4px">${tags().map(t2=>`<span class="tag ${tag===(n&&n.tags.includes(t2))?"green":""}" data-t="${esc(t2)}" style="cursor:pointer"># ${esc(t2)}</span>`).join("")||`<span class="muted" style="font-size:11px">康奈尔结构笔记 · 自动保存 · 支持打印</span>`}</div>`;
    wrap.innerHTML = `
      <div class="toolbar no-print">
        <input id="nb-kw" placeholder="🔍 搜索课题/问题/要点…" value="${esc(kw)}" style="min-width:220px">
        <button class="btn btn-primary" id="nb-new">＋ 新建康奈尔笔记</button>
        <span class="muted">左栏提问 · 右栏记知识 · 底栏总结 —— 复习时遮住右栏自测</span>
      </div>
      <div class="notes-layout">
        <div class="nb-side">${sideHTML}</div>
        <div class="nb-main">
          ${n?`<div class="nb-scroll no-print-off">${cornellHTML(n,false)}</div><input type="file" id="cn-file" accept="image/*" style="display:none">`
             :`<div class="empty" style="margin:auto"><span class="eico">📓</span>从左侧选择笔记，或点击「＋ 新建康奈尔笔记」<br><span class="muted" style="font-size:11px">康奈尔版式：课题 → 线索提问（25%）→ 知识点模块（75%）→ 总结</span></div>`}
        </div>
      </div>`;
    // —— 侧栏交互 ——
    document.querySelector("[data-all]").onclick = ()=>{ saveNow(); cur=null; render(); };
    document.querySelectorAll("[data-book]").forEach(el=>el.onclick=()=>{
      saveNow();
      const b2 = el.dataset.book;
      openBooks[b2] = !openBooks[b2];
      if(openBooks[b2] && !cur){
        const first = state.notes.filter(x=>x.book===b2).sort((a,b)=>(b.updated||"").localeCompare(a.updated||""))[0];
        if(first) cur = first.id;
      }
      render();
    });
    document.querySelectorAll("[data-n]").forEach(el=>el.onclick=()=>{ saveNow(); cur = el.dataset.n; dirty=false; render(); });
    $("#nb-kw").oninput = ()=>{ const v = $("#nb-kw").value; render(); const el=$("#nb-kw"); el.value=v; el.focus(); };
    $("#nb-new").onclick = ()=>{
      const nn = {id:uid("NT"), book:books()[0]||"我的笔记", tags:[],
        topic:"新课题", cues:["这一节的核心问题是什么？"],
        blocks:[{id:uid("B"), icon:"bulb", title:"核心概念", text:"", bullets:[], flow:[], table:null, img:""}],
        summary:"", updated:stamp()};
      state.notes.push(nn); cur = nn.id; openBooks[nn.book]=true; save(); toast("📝 已新建，编辑自动保存"); render();
      const t = $("#cn-topic"); if(t){ t.focus(); t.select(); }
    };
    $("#nb-addbook").onclick = ()=>{
      modal("新建笔记本", `<input id="nbk" placeholder="笔记本名称，如：数学 · 第三章" style="width:100%">`,
        [{text:"取消"},{text:"创建",cls:"btn-primary",fn:()=>{
          const v = $("#nbk").value.trim(); if(!v) return false;
          const nn = {id:uid("NT"), book:v, tags:[], topic:"新课题", cues:[], 
            blocks:[{id:uid("B"), icon:"book", title:"知识点", text:"", bullets:[], flow:[], table:null, img:""}],
            summary:"", updated:stamp()};
          state.notes.push(nn); cur = nn.id; openBooks[v]=true; save(); render();
        }}]);
    };
    $("#nb-rebook").onclick = ()=>{
      if(!books().length){ toast("还没有笔记本", true); return; }
      modal("重命名笔记本", `<label>选择笔记本<select id="rb-old" style="width:100%">${books().map(b2=>`<option>${esc(b2)}</option>`).join("")}</select></label>
        <label style="display:block;margin-top:10px">新名称<input id="rb-new" placeholder="输入新名称" style="width:100%"></label>`,
        [{text:"取消"},{text:"重命名",cls:"btn-primary",fn:()=>{
          const o=$("#rb-old").value, v=$("#rb-new").value.trim();
          if(!v) return false;
          state.notes.forEach(x=>{ if(x.book===o) x.book=v; });
          if(openBooks[o]){ openBooks[v]=true; delete openBooks[o]; }
          save(); toast("📓 笔记本已重命名"); render();
        }}]);
    };
    if(n) bindSheet(n);
  }
  render();
};

/* ---------- 任课教师 · 监考/值班/会议 ---------- */
PAGES.duties = function(){
  const wrap = $("#page-body");
  function render(){
    const f = $("#dt-f")?.value||"";
    const list = state.duties.filter(d=>!f||d.type===f).slice().sort((a,b)=>a.date.localeCompare(b.date));
    wrap.innerHTML = panel("监考 · 值班 · 教研与会议", `
      <div class="toolbar">
        <select id="dt-f"><option value="">全部类型</option><option ${f==="监考"?"selected":""}>监考</option><option ${f==="值班"?"selected":""}>值班</option><option ${f==="会议"?"selected":""}>会议</option></select>
        <button class="btn btn-primary" id="dt-add">＋ 新增安排</button>
      </div>
      ${tableHTML(["日期","类型","安排详情"], list.map(d=>[d.date,
        `<span class="tag ${d.type==="监考"?"warn":d.type==="会议"?"blue":"green"}">${esc(d.type)}</span>`, esc(d.detail)]), {rowClick:true})}`);
    $("#dt-f").onchange = render;
    $("#dt-add").onclick = ()=>{
      modal("新增安排", `<div class="form-grid">
        <label>类型<select id="dtf-t"><option>监考</option><option>值班</option><option>会议</option></select></label>
        <label>日期<input id="dtf-d" type="date" value="${todayStr()}"></label>
        <label class="full">详情<textarea id="dtf-x" rows="2" placeholder="如：初二年级 数学单元测 · 第1-2节 · 第3考场"></textarea></label>
      </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
        const x = $("#dtf-x").value.trim(); if(!x){toast("请填写详情",true);return false;}
        state.duties.push({date:$("#dtf-d").value, type:$("#dtf-t").value, detail:x});
        save(); toast("已保存"); render();
      }}]);
    };
  }
  render();
};

/* ================================================================
   学生端（只读：教师笔记 / 我的积分；可写：作业提交）
================================================================ */
function stuSelf(){ return state.students.find(s=>s.id===session.stuId) || state.students.find(s=>s.name===session.name && s.cls===session.cls); }
PAGES.stu_dash = function(){
  const s = stuSelf();
  if(!s){ $("#page-body").innerHTML = panel("我的工作台", `<div class="empty">未找到学籍信息，请联系超级管理员</div>`); return; }
  const cls = s.cls;
  const list = state.homework.filter(h=>h.cls===cls);
  const my = state.hws.filter(x=>x.cls===cls && x.student===s.name);
  const pend = list.filter(h=>!hwSub(h.id, s.name)).length;
  const ptRecs = state.points.filter(p=>p.studentId===s.id);
  $("#page-body").innerHTML = `
    <div class="hero-greet">
      <h2>${greetWord()}，${esc(s.name)}。<span class="hl">今天也要加油。</span></h2>
      <p>${esc(cls)} · 待提交作业 ${pend} 份 · 累计积分 ${ptRecs.reduce((a,b)=>a+b.points,0)} 分</p>
      <div class="toolbar" style="margin:14px 0 0">
        <button class="btn btn-primary" data-goto="stu_hw">📝 作业与练习</button>
        <button class="btn" data-goto="stu_notes">📓 教师笔记</button>
      </div>
    </div>
    <div class="cards c4">
      ${statCard("📝 待提交作业", pend+" <small>份</small>", pend?"danger":"green")}
      ${statCard("📥 已提交", my.length+" <small>份</small>","")}
      ${statCard("🖊 已批改", my.filter(x=>x.level).length+" <small>份</small>","accent")}
      ${statCard("🌟 我的积分", ptRecs.reduce((a,b)=>a+b.points,0)+" <small>分</small>","warn")}
    </div>
    <div class="grid-2">
      <div>${panel("最近的作业", list.slice(0,4).map(h=>{
        const sub = hwSub(h.id, s.name);
        return `<div class="comm-item"><b>${esc(h.title)}</b>
          <span class="tag ${sub?(sub.level?"green":"blue"):"warn"}">${sub?(sub.level?"已批改 "+sub.level:"已提交"):"未提交"}</span>
          <div class="meta"><span>${esc(h.date)} · ${esc(h.teacher)}</span></div></div>`;
      }).join("")||`<div class="empty">暂无作业</div>`)}</div>
      <div>${panel("老师给我的最新评价", my.filter(x=>x.level).slice(-3).reverse().map(x=>{
        const hw = state.homework.find(h=>h.id===x.hwId);
        return `<div class="comm-item"><b>${esc(hw?hw.title:"作业")}</b><span class="tag green">${esc(x.level)}</span>
          ${x.comment?`<div class="s muted">${esc(x.comment)}</div>`:""}
          <div class="meta"><span>${esc(x.date)}</span></div></div>`;
      }).join("")||`<div class="empty"><span class="eico">🖊</span>还没有收到批改，提交作业后老师会在此反馈</div>`)}</div>
    </div>`;
  document.querySelectorAll("[data-goto]").forEach(b=>b.onclick=()=>navigate(b.dataset.goto));
};
PAGES.stu_hw = function(){
  const wrap = $("#page-body");
  const s = stuSelf();
  if(!s){ $("#page-body").innerHTML = panel("作业与练习", `<div class="empty">未找到学籍信息，请联系超级管理员</div>`); return; }
  function render(){
    const list = state.homework.filter(h=>h.cls===s.cls).sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
    const my = state.hws.filter(x=>x.cls===s.cls && x.student===s.name);
    wrap.innerHTML = `
      <div class="cards c3">
        ${statCard("已发布作业", list.length+" <small>份</small>","accent")}
        ${statCard("已提交", my.length+" <small>份</small>","green")}
        ${statCard("待提交", list.filter(h=>!hwSub(h.id,s.name)).length+" <small>份</small>", list.some(h=>!hwSub(h.id,s.name))?"danger":"")}
      </div>` +
      panel(`作业与练习 <span class="muted">${esc(s.cls)}</span>`, list.map(h=>{
        const sub = hwSub(h.id, s.name);
        const miss = hwMissed(s.cls, s.name);
        const nameCls = sub?"":hwMissCls(miss);
        return `<div class="comm-item" data-hwid="${h.id}">
          <b class="${nameCls}">${esc(h.title)}</b>
          <span class="tag ${sub?(sub.level?"green":"blue"):"warn"}">${sub?(sub.level?`已批改 ${sub.level}`:"已提交 · 待批改"):"未提交"}</span>
          <span class="muted">${esc(h.date)} · ${esc(h.teacher)}</span>
          ${h.desc?`<div class="s muted">${esc(h.desc)}</div>`:""}
          ${h.images&&h.images.length?`<div class="hw-imgs" style="margin-top:6px">${h.images.map((src,i)=>`<img src="${src}" data-hwti="${i}" alt="作业图${i+1}">`).join("")}<span class="muted s" style="align-self:center">📎 老师附件 ${h.images.length} 张 · 点击放大</span></div>`:""}
          ${sub&&sub.comment?`<div class="s" style="color:var(--ok)">老师评语：${esc(sub.comment)}</div>`:""}
          <div class="meta">
            ${sub?`<span class="link" data-hwmy="${h.id}">查看我的提交</span>`:`<span class="link" data-hwup="${h.id}">📤 提交作业（上传图片）</span>`}
          </div></div>`;
      }).join("") || `<div class="empty"><span class="eico">📝</span>老师还没有发布作业，发布后这里会第一时间显示</div>`, "", true);
    wrap.querySelectorAll("[data-hwup]").forEach(e=>e.onclick=()=>submitHwModal(state.homework.find(h=>h.id===e.dataset.hwup)));
    wrap.querySelectorAll("[data-hwti]").forEach(el=>el.onclick=()=>{
      const hw = state.homework.find(h=>h.id===el.closest(".comm-item")?.dataset.hwid);
      if(hw && hw.images) imgViewer(hw.images, +el.dataset.hwti);
    });
    wrap.querySelectorAll("[data-hwmy]").forEach(e=>e.onclick=()=>{
      const sub = hwSub(e.dataset.hwmy, s.name);
      modal("我的提交", `<div class="hw-imgs">${sub.images.map((src,i)=>`<img src="${src}" data-myw="${i}" style="cursor:zoom-in">`).join("")}</div>
        ${sub.level?`<p style="margin-top:8px">评分：<span class="tag green">${esc(sub.level)}</span>${sub.comment?` · 评语：${esc(sub.comment)}`:""}</p>`:""}
        <p class="muted s" style="margin-top:6px">点击图片可放大，放大后可用左右按钮翻页</p>`,
        [{text:"关闭"}]);
      document.querySelectorAll("#modal-root [data-myw]").forEach(el=>el.onclick=()=>imgViewer(sub.images, +el.dataset.myw));
    });
  }
  function submitHwModal(hw){
    const imgs = [];
    modal("提交作业 · "+hw.title, `
      <div class="import-zone" id="hwz" style="cursor:pointer">
        <div style="font-size:34px">📷</div><b>点击选择作业图片（可多选）</b>
        <p class="muted" style="margin-top:4px">支持 JPG / PNG，上传后自动压缩保存</p>
      </div>
      <input type="file" id="hwf" accept="image/*" multiple style="display:none">
      <div id="hw-prev" class="hw-imgs" style="margin-top:10px"></div>`,
      [{text:"取消"},{text:"📤 提交给老师",cls:"btn-primary",fn:()=>{
        if(!imgs.length){ toast("请先选择作业图片", true); return false; }
        const now = new Date();
        state.hws.push({id:uid("HS"), hwId:hw.id, cls:hw.cls, student:s.name, images:imgs,
          date:todayStr(), time:now.toTimeString().slice(0,5)});
        save(); toast("✅ 提交成功，老师已收到"); PAGES.stu_hw();
      }}]);
    $("#hwz").onclick = ()=>$("#hwf").click();
    $("#hwf").onchange = async ()=>{
      const files = [...$("#hwf").files];
      for(const f of files){
        try{ imgs.push(await compressImage(f)); }catch(e){}
      }
      $("#hw-prev").innerHTML = imgs.map(src=>`<img src="${src}">`).join("");
      if(files.length) toast(`已添加 ${files.length} 张图片`);
      $("#hwf").value = "";
    };
  }
  render();
};
PAGES.stu_notes = function(){
  const wrap = $("#page-body");
  migrateNotes();
  let cur = state.notes.length? state.notes[state.notes.length-1].id : null;
  let book = "";
  const nT = x=>x.topic||x.title||"无标题";
  function render(){
    const books = [...new Set(state.notes.map(n=>n.book))];
    const n = state.notes.find(x=>x.id===cur);
    const list = state.notes.filter(x=>!book||x.book===book);
    wrap.innerHTML = `
      <div class="toolbar no-print"><span class="muted">教师笔记为只读同步（康奈尔版式） · 内容来自任课教师</span>
        ${n?`<button class="btn btn-sm" id="cn-print-ro">${ic("printer",13)} 打印</button>`:""}</div>
      <div class="notes-layout">
        <div class="nb-side">
          <div class="nb-tree-item ${!book?"active":""}" data-bk="">🗂 全部笔记 <span class="cnt">${state.notes.length}</span></div>
          ${books.map(b2=>`<div class="nb-tree-item ${book===b2?"active":""}" data-bk="${esc(b2)}">📁 ${esc(b2)} <span class="cnt">${state.notes.filter(x=>x.book===b2).length}</span></div>`).join("")}
        </div>
        <div class="nb-main">
          ${n?`<div class="nb-scroll">${cornellHTML(n,true)}</div>`
          :`<div class="empty" style="margin:auto"><span class="eico">📓</span>老师还没有发布笔记</div>`}
        </div>
      </div>`;
    document.querySelectorAll("[data-bk]").forEach(el=>el.onclick=()=>{ book=el.dataset.bk; render(); });
    const pb=$("#cn-print-ro"); if(pb) pb.onclick=()=>window.print();
    if(!cur && list.length) { cur = list[list.length-1].id; render(); return; }
    // 笔记列表（点击标题查看）
    const side = wrap.querySelector(".nb-side");
    side.insertAdjacentHTML("beforeend", `<div class="sec-title">笔记列表</div>` +
      list.map(x=>`<div class="nb-sub-item ${x.id===cur?"active":""}" data-n="${x.id}">${esc(nT(x))}<div class="d">${esc(x.updated||"")}</div></div>`).join("") ||
      `<div class="nb-sub-item muted">（无）</div>`);
    side.querySelectorAll("[data-n]").forEach(el=>el.onclick=()=>{ cur=el.dataset.n; render(); });
  }
  render();
};
PAGES.stu_points = function(){
  const wrap = $("#page-body");
  const s = stuSelf();
  if(!s){ $("#page-body").innerHTML = panel("我的积分", `<div class="empty">未找到学籍信息</div>`); return; }
  const recs = state.points.filter(p=>p.studentId===s.id).sort((a,b)=>b.date.localeCompare(a.date));
  const total = recs.reduce((a,b)=>a+b.points,0);
  wrap.innerHTML = `
    <div class="cards c3">
      ${statCard("🌟 累计积分", total+" <small>分</small>","accent")}
      ${statCard("记录条数", recs.length+" <small>条</small>")}
      ${statCard("最近变动", recs.length?(recs[0].points>0?"+":"")+recs[0].points:"—", recs[0]?.points<0?"danger":"green")}
    </div>` +
    panel("积分明细（只读）", tableHTML(["日期","分值","事由","教师"],
      recs.map(p=>[p.date, `<span class="${p.points>=0?"num-up":"num-down"}">${p.points>0?"+":""}${p.points}</span>`, esc(p.reason||"课堂表现"), esc(p.teacher)]),
      {noSort:true}), "", true);
};

/* ---------- 超级管理员 ---------- */
PAGES.adm_overview = function(){
  $("#page-body").innerHTML = `
    <div class="cards c4">
      ${statCard("🏫 班级", state.classes.length+" <small>个</small>","accent")}
      ${statCard("🎒 学生", state.students.length+" <small>人</small>","green")}
      ${statCard("👥 教师账号", state.users.length+" <small>个</small>","warn")}
      ${statCard("📝 已发布作业", state.homework.length+" <small>份</small>")}
    </div>` +
    panel("快捷入口", `<div class="toolbar" style="margin:0">
      <button class="btn" data-goto="adm_users">👥 教师账号管理</button>
      <button class="btn" data-goto="adm_cls">🏫 班级与学生</button></div>`) +
    panel("管理说明", `<p class="muted" style="line-height:1.9">
      1. 在「教师账号管理」创建班主任 / 任课教师账号并设置密码，支持增删改查；<br>
      2. 在「班级与学生」建立班级、指定班主任、录入学生姓名；<br>
      3. 学生账号默认为学生姓名，密码固定为 123456，学生本人不可修改；<br>
      4. 教师登录后可在顶栏切换班级、导入学生名单；学生登录后仅能查看本班教师的笔记与积分（只读）并提交作业。</p>`);
  document.querySelectorAll("[data-goto]").forEach(b=>b.onclick=()=>navigate(b.dataset.goto));
};
PAGES.adm_users = function(){
  const wrap = $("#page-body");
  function log(action, target){
    state.auditLogs.unshift({time:new Date().toLocaleString("zh-CN",{hour12:false}), user:"ZINNIA(超级管理员)", action, target, scope:"全校", result:"成功"});
  }
  function render(){
    wrap.innerHTML = panel("教师账号管理", `
      <div class="toolbar">
        <button class="btn btn-primary" id="us-add">＋ 新建教师账号</button>
        <span class="muted">账号 / 密码均可增删改查；停用后该账号立即无法登录</span>
      </div>` +
      tableHTML(["姓名","账号","角色","学科","负责班级","密码","状态","操作"],
        state.users.map(u=>[esc(u.name),esc(u.account),esc(u.role),esc(u.subject||"—"),esc(u.classes||"—"),
          `<span class="muted">${esc(u.password||"123456")}</span>`,
          `<span class="tag ${u.status==="启用"?"green":"red"}">${u.status}</span>`,
          `<span class="link" data-use="${u.id}">编辑</span> · <span class="link" data-ust="${u.id}">${u.status==="启用"?"停用":"启用"}</span> · <span class="link" style="color:var(--danger)" data-usd="${u.id}">删除</span>`]),
        {noSort:true}), "", true);
    $("#us-add").onclick = ()=>userForm(null);
    wrap.querySelectorAll("[data-use]").forEach(e=>e.onclick=()=>userForm(state.users.find(x=>x.id===e.dataset.use)));
    wrap.querySelectorAll("[data-ust]").forEach(e=>e.onclick=()=>{
      const u = state.users.find(x=>x.id===e.dataset.ust);
      confirmBox(`确认${u.status==="启用"?"停用":"启用"}账号「${u.name}」？停用后其会话将立即失效。`,
        ()=>{ u.status = u.status==="启用"?"停用":"启用"; log("修改账号状态", u.name+"("+u.account+")"); save(); toast("已更新并留痕"); render(); });
    });
    wrap.querySelectorAll("[data-usd]").forEach(e=>e.onclick=()=>{
      const u = state.users.find(x=>x.id===e.dataset.usd);
      confirmBox(`确认删除教师账户「${u.name}（${u.account}）」？该账户将立即退出登录且无法再登录，其名下教学记录保留原始归属与审计痕迹。`,
        ()=>{ state.users = state.users.filter(x=>x.id!==u.id); log("删除账户", u.name+"("+u.account+")"); save(); toast("账户已删除并留痕"); render(); });
    });
  }
  function userForm(u){
    const isNew = !u;
    u = u||{id:uid("U"), name:"",account:"",password:"123456",role:"任课教师",subject:"",classes:"",status:"启用"};
    modal(isNew?"新建教师账号":"编辑教师账号", `<div class="form-grid">
      <label>姓名<input id="uf-name" value="${esc(u.name)}"></label>
      <label>账号<input id="uf-acc" value="${esc(u.account)}"></label>
      <label>密码<input id="uf-pwd" value="${esc(u.password||"123456")}"></label>
      <label>角色<select id="uf-role"><option ${u.role==="班主任"?"selected":""}>班主任</option><option ${u.role==="任课教师"?"selected":""}>任课教师</option></select></label>
      <label>学科<input id="uf-sub" value="${esc(u.subject||"")}" placeholder="多门课用与/、/，分隔，如：计算机基础与Python"></label>
      <label class="full">负责班级<input id="uf-cls" value="${esc(u.classes||"")}" placeholder="如 初二(3)班、初二(5)班"></label>
    </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
      const name = $("#uf-name").value.trim(), acc = $("#uf-acc").value.trim(), pwd = $("#uf-pwd").value;
      if(!name||!acc){ toast("姓名与账号必填", true); return false; }
      if(state.users.some(x=>x.account===acc && x.id!==u.id)){ toast("账号已存在", true); return false; }
      Object.assign(u, {name, account:acc, password:pwd||"123456", role:$("#uf-role").value,
        subject:$("#uf-sub").value.trim(), classes:$("#uf-cls").value.trim()});
      if(isNew) state.users.push(u);
      log(isNew?"创建账户":"修改账户", name+"("+acc+")");
      save(); toast("已保存并留痕"); render();
    }}]);
  }
  render();
};
PAGES.adm_cls = function(){
  const wrap = $("#page-body");
  let sel = state.classes[0]? state.classes[0].name : "";
  const log = (action, target)=> state.auditLogs.unshift({time:new Date().toLocaleString("zh-CN",{hour12:false}), user:"ZINNIA(超级管理员)", action, target, scope:"全校", result:"成功"});
  function render(){
    if(!state.classes.length) sel = "";
    const co = classObj(sel);
    const st = state.students.filter(s=>s.cls===sel);
    const teachers = state.users.map(u=>u.name);
    wrap.innerHTML = panel("班级与学生", `
      <div class="toolbar">
        <select id="ac-cls" ${state.classes.length?"":"disabled"}>${state.classes.map(c=>`<option ${c.name===sel?"selected":""}>${esc(c.name)}</option>`).join("")}</select>
        <button class="btn btn-primary" id="ac-addcls">＋ 新增班级</button>
        <button class="btn" id="ac-delcls" ${state.classes.length?"":"disabled"}>🗑 删除当前班级</button>
        <span class="muted">班主任
          <select id="ac-ht" ${co?"":"disabled"}><option value="">（未指定）</option>${teachers.map(t=>`<option ${co&&co.headteacher===t?"selected":""}>${esc(t)}</option>`).join("")}</select>
        </span>
      </div>
      <div class="toolbar">
        <button class="btn" id="ac-addstu" ${sel?"":"disabled"}>＋ 添加学生</button>
        <button class="btn" id="ac-imp" ${sel?"":"disabled"}>Excel/CSV 导入名单</button>
        <span class="muted">${sel?`「${esc(sel)}」共 ${st.length} 名学生 · 学生账号=姓名，密码固定 123456 且不可修改`:"请先新增班级"}</span>
      </div>
      <div id="ac-table">${tableHTML(["姓名","性别","监护人","电话","操作"],
        st.map(s=>[`<b>${esc(s.name)}</b>`, s.gender, esc(s.guardian)||"—", esc(s.phone)||"—",
          `<span class="link" style="color:var(--danger)" data-sdel="${s.id}">删除</span>`]), {noSort:true})}</div>`, "", true);
    $("#ac-cls").onchange = e=>{ sel = e.target.value; render(); };
    $("#ac-addcls").onclick = ()=>{
      modal("新增班级", `<label>班级名称<input id="acf-name" placeholder="如 初二(3)班"></label>`,
        [{text:"取消"},{text:"创建",cls:"btn-primary",fn:()=>{
          const v = $("#acf-name").value.trim();
          if(!v){ toast("请填写班级名称", true); return false; }
          if(state.classes.some(c=>c.name===v)){ toast("班级已存在", true); return false; }
          state.classes.push({id:uid("C"), name:v, headteacher:""});
          sel = v; log("新增班级", v); save(); toast("班级已创建"); render();
        }}]);
    };
    $("#ac-delcls").onclick = ()=>{
      const n = st.length;
      confirmBox(`确认删除班级「${sel}」？班内 ${n} 名学生档案将一并删除，学生账号随之失效。`, ()=>{
        state.classes = state.classes.filter(c=>c.name!==sel);
        state.students = state.students.filter(s=>s.cls!==sel);
        log("删除班级", sel); sel = state.classes[0]? state.classes[0].name : "";
        save(); toast("班级已删除"); render();
      });
    };
    $("#ac-ht").onchange = e=>{ if(co){ co.headteacher = e.target.value; save(); toast("班主任已更新"); } };
    $("#ac-addstu").onclick = ()=>{
      modal(`添加学生 · ${sel}`, `<div class="form-grid">
        <label>姓名<input id="asf-name"></label>
        <label>性别<select id="asf-gender"><option>男</option><option>女</option></select></label>
        <label>监护人<input id="asf-g"></label>
        <label>联系电话<input id="asf-p"></label>
        <label class="full muted">保存后学生即可用「姓名 + 123456」登录学生端。</label>
      </div>`, [{text:"取消"},{text:"保存",cls:"btn-primary",fn:()=>{
        const name = $("#asf-name").value.trim();
        if(!name){ toast("请填写姓名", true); return false; }
        if(st.some(x=>x.name===name)){ toast("该班已有同名学生", true); return false; }
        state.students.push({id:uid("HT"), cls:sel, name, gender:$("#asf-gender").value,
          guardian:$("#asf-g").value.trim(), phone:$("#asf-p").value.trim(), tags:[], remark:""});
        save(); toast("学生已添加"); render();
      }}]);
    };
    $("#ac-imp").onclick = ()=>{
      importModal("学生名单导入格式（每行）：姓名,性别,监护人,电话 —— 账号=姓名，密码 123456", lines=>{
        let n=0;
        lines.forEach(l=>{
          const [name,gender,guardian,phone] = l.split(",").map(x=>x?.trim());
          if(name && !st.some(s=>s.name===name)){
            state.students.push({id:uid("HT"), cls:sel, name, gender:gender||"男", guardian:guardian||"", phone:phone||"", tags:[], remark:""});
            n++;
          }
        });
        save(); toast(`成功导入 ${n} 名学生（重复跳过）`); render();
      });
    };
    wrap.querySelectorAll("[data-sdel]").forEach(e=>e.onclick=()=>{
      const s = state.students.find(x=>x.id===e.dataset.sdel);
      confirmBox(`确认删除学生「${s.name}」？其学生账号将失效，关联成绩与档案记录保留原始归属。`,
        ()=>{ state.students = state.students.filter(x=>x.id!==s.id); save(); toast("已删除"); render(); });
    });
  }
  render();
};
PAGES.adm_roles = function(){
  const perms = ["查看","编辑","下载","分享","删除","敏感数据"];
  const roles = {"超级管理员":["全校数据（账号/班级/学生/密码）","✓","✓","✓","✓","二次确认","审计可见"],
    "班主任":["本班数据","✓","✓","需授权","需授权","二次确认","需单独授权"],
    "任课教师":["授课班级+科目","✓","✓","需授权","—","二次确认","需单独授权"],
    "学生":["本班内容（只读）+ 本人作业提交","仅本人相关","—","—","—","—","—"]};
  $("#page-body").innerHTML = panel("角色与权限矩阵", tableHTML(["角色","数据范围",...perms],
    Object.entries(roles).map(([r,[scope,...v]])=>[esc(r),esc(scope),...v.map(x=>`<span class="tag ${x==="✓"?"green":String(x).includes("确认")||String(x).includes("授权")?"warn":""}">${esc(x)}</span>`)]), {noSort:true}) +
    `<p class="muted" style="margin-top:10px">登录说明：超级管理员（ZINNIA）每次登录都必须重新输入账号密码，不做会话记忆；教师账号由超级管理员创建；学生账号=姓名，密码 123456 不可修改。</p>`);
};
PAGES.adm_logs = function(){
  $("#page-body").innerHTML = panel("操作日志（审计）", `<div class="toolbar">
    <button class="btn" id="lg-exp">导出日志 CSV</button></div>` +
    tableHTML(["时间","用户","操作","对象","范围","结果"], state.auditLogs.map(l=>[esc(l.time),esc(l.user),esc(l.action),
      esc(l.target),esc(l.scope),`<span class="tag ${l.result.includes("失败")?"red":"green"}">${esc(l.result)}</span>`]), {rowClick:true}), `<button class="btn btn-sm" onclick="toast('演示：敏感操作需单独授权')">敏感操作筛选</button>`);
  $("#lg-exp").onclick = ()=>exportCSV("操作日志", ["时间","用户","操作","对象","范围","结果"],
    state.auditLogs.map(l=>[l.time,l.user,l.action,l.target,l.scope,l.result]));
};
PAGES.adm_set = function(){
  $("#page-body").innerHTML = panel("系统设置", `<div class="form-grid">
    <label>学校名称<input id="ts-name" value="${esc(state.tenant.name)}"></label>
    <label>学年<input id="ts-year" value="${esc(state.tenant.year)}"></label>
    <label>学期<input id="ts-term" value="${esc(state.tenant.term)}"></label>
    <label class="full muted">超级管理员账号固定为 ZINNIA，每次登录必须重新输入账号与密码；学生密码固定 123456 不可修改；教师密码由超级管理员在「教师账号管理」中维护。</label>
  </div>`, `<button class="btn btn-primary" id="ts-save">保存</button>`);
  $("#ts-save").onclick = ()=>{
    const v=$("#ts-name").value.trim(); if(v){ state.tenant.name=v; }
    state.tenant.year = $("#ts-year").value.trim(); state.tenant.term = $("#ts-term").value.trim();
    save(); toast("设置已保存");
  };
};

/* ================================================================
   作业完成记录表 v2：日期/节次/科目 · 每次授课汇入一条记录
   数据：state.hwSessions = [{id,cls,date,period,subject,folder,files,ignored,manual,savedAt}]
   科目联动教师账号「学科」字段；按月/按年查询导出；连2次未交橙名、连3次红名
================================================================ */
function hwSessions(){ if(!Array.isArray(state.hwSessions)) state.hwSessions = []; return state.hwSessions; }
/* 归一化：忽略大小写、空格与常见分隔符，用于模糊匹配 */
const HW_NORM = s => String(s||"").toLowerCase().replace(/[\s_\-—–·.,，。()（）\[\]【】“”"'']+/g, "");
function hwSize(n){ if(n==null) return ""; if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB"; return (n/1048576).toFixed(2)+" MB"; }
function hwTime(ts){ if(!ts) return "—"; const d=new Date(ts), p=n=>String(n).padStart(2,"0"); return p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()); }
/* 匹配引擎：文件相对路径（含子文件夹名）包含学生姓名或学号 → 该生已交 */
function hwMatch(sess){
  const st = state.students.filter(s=>s.cls===sess.cls);
  const files = sess.files||[];
  const used = new Set(), auto = {};
  st.forEach(s=>{
    const keys = [HW_NORM(s.name), HW_NORM(s.id)].filter(k=>k.length>=2);
    auto[s.name] = files.filter(f=>keys.some(k=>HW_NORM(f.rel).includes(k)));
    auto[s.name].forEach(f=>used.add(f.rel));
  });
  const manualRels = new Set(Object.values(sess.manual||{}).flat().map(f=>f.rel));
  const unmatched = files.filter(f=>!used.has(f.rel) && !manualRels.has(f.rel));
  const rows = st.map(s=>({ s, files:(auto[s.name]||[]).concat((sess.manual||{})[s.name]||[]) }));
  rows.forEach(r=>r.sub = r.files.length>0);
  return { st, auto, unmatched, rows };
}
/* 某条记录中学生是否已交（自动匹配或手动指定均算） */
function hwIsSubmitted(sess, name){
  if(((sess.manual||{})[name]||[]).length) return true;
  const s = state.students.find(x=>x.cls===sess.cls && x.name===name);
  if(!s) return false;
  const keys = [HW_NORM(s.name), HW_NORM(s.id)].filter(k=>k.length>=2);
  return (sess.files||[]).some(f=>keys.some(k=>HW_NORM(f.rel).includes(k)));
}
/* 连续未交次数：该班该科目从最近一条已汇入记录向前数 */
function hwMissStreak(cls, subject, name){
  const list = hwSessions().filter(s=>s.cls===cls && s.subject===subject)
    .sort((a,b)=>(a.date+a.period).localeCompare(b.date+b.period));
  let n=0;
  for(let i=list.length-1;i>=0;i--){ if(hwIsSubmitted(list[i],name)) break; n++; }
  return n;
}
/* 姓名着色：连3次未交红 / 连2次橙 */
function hwNameHTML(cls, subject, name){
  const k = hwMissStreak(cls, subject, name);
  if(k>=3) return `<b class="miss3" title="已连续 ${k} 次未交「${esc(subject)}」作业">${esc(name)}</b>`;
  if(k===2) return `<b class="miss2" title="已连续 2 次未交「${esc(subject)}」作业">${esc(name)}</b>`;
  return `<b>${esc(name)}</b>`;
}

/* ---------- Excel 名单：从表格里识别「姓名 / 学号 / 状态」列 ---------- */
const SHEET_OK_WORDS = ["已交","已提交","提交","交","交了","完成","已完成","是","有","√","✓","y","yes","true","ok"];
const SHEET_NO_WORDS = ["未交","未提交","没交","缺交","欠交","未完成","否","无","没有","×","✗","x","n","no","false"];
/* 状态单元格 → true(已交) / false(未交) / null(认不出，按已交处理) */
function sheetStatusOf(v){
  const t = HW_NORM(v); if(!t) return null;
  if(SHEET_NO_WORDS.some(k=>t===HW_NORM(k))) return false;
  if(SHEET_OK_WORDS.some(k=>t===HW_NORM(k))) return true;
  if(/未|没|缺|欠/.test(t)) return false;
  if(/已|提交|完成|√|✓|是|有/.test(t)) return true;
  return null;
}
/* 二维表格 → 名单行；优先认表头，没有表头就按本班学生姓名命中率猜列 */
function sheetDetect(grid, st){
  const norm = s=>HW_NORM(s);
  const body = (grid||[]).filter(r=>r && r.some(c=>String(c??"").trim()!==""));
  if(!body.length) return null;
  let head = -1, nameCol = -1, idCol = -1, stCol = -1;
  for(let ri=0; ri<Math.min(body.length, 6); ri++){
    const r = body[ri];
    for(let ci=0; ci<r.length; ci++){
      const t = String(r[ci]??"").trim(); if(!t) continue;
      if(nameCol<0 && /^(姓名|名字|学生|学生姓名|学生名|学生名称|name)$/i.test(t)) nameCol = ci;
      if(idCol<0 && /^(学号|学籍号|考号|考籍号|编号|id)$/i.test(t)) idCol = ci;
      if(stCol<0 && /(是否|状态|提交|完成|交作业|情况|备注)/.test(t)) stCol = ci;
    }
    if(nameCol >= 0){ head = ri; break; }
  }
  if(nameCol < 0){
    const names = st.map(s=>norm(s.name)).filter(k=>k.length>=2);
    const ids = st.map(s=>norm(s.id)).filter(k=>k.length>=3);
    let bestN = 0, bestI = -1, bestD = 0, bestId = -1;
    for(let ci=0; ci<30; ci++){
      let n = 0, d = 0;
      body.slice(0, 15).forEach(r=>{
        const t = norm(r[ci]); if(!t) return;
        if(names.some(k=>t===k || t.includes(k))) n++;
        if(ids.some(k=>t===k)) d++;
      });
      if(n > bestN){ bestN = n; bestI = ci; }
      if(d > bestD){ bestD = d; bestId = ci; }
    }
    if(bestI < 0 || bestN <= 0) return null;      // 一列都认不出 → 放弃
    nameCol = bestI; head = -1;
    if(bestId >= 0 && bestId !== bestI) idCol = bestId;
  }
  const data = body.slice(head >= 0 ? head+1 : 0);
  const rows = [];
  data.forEach(r=>{
    const nm  = nameCol>=0 ? String(r[nameCol]??"").trim() : "";
    const sid = idCol>=0  ? String(r[idCol]??"").trim()  : "";
    if(!nm && !sid) return;
    const rawSt = stCol>=0 ? String(r[stCol]??"").trim() : "";
    rows.push({ name:nm, sid:sid, status:sheetStatusOf(rawSt), rawSt:rawSt });
  });
  return rows.length ? { nameCol, idCol, stCol, head, rows } : null;
}
PAGES.homerec = function(){
  const wrap = $("#page-body");
  const periods = (state.periods&&state.periods.length)? state.periods : ["第1节"];
  let filter="all", sortKey="no", sortDir=1;
  const drafts = {};                       // 页内草稿缓存：key -> 未汇入的编辑对象
  render();
  function sel(){                          // 顶部三个选择器的当前值
    const subs = subjectsFor(curCls());
    return {
      date: $("#hr-date")?.value || todayStr(),
      period: $("#hr-period")?.value || periods[1] || periods[0],
      subject: $("#hr-sub")?.value || subs[0] || "课程"
    };
  }
  function savedByKey(k){ return hwSessions().find(s=>s.cls===k.cls&&s.date===k.date&&s.period===k.period&&s.subject===k.subject); }
  function dkey(k){ return k.cls+"|"+k.date+"|"+k.period+"|"+k.subject; }
  function target(){                       // 当前编辑/展示对象：已存记录优先，否则草稿
    const k = sel(); k.cls = curCls();
    const sv = savedByKey(k);
    if(sv) return sv;
    if(!drafts[dkey(k)]) drafts[dkey(k)] = {cls:k.cls, date:k.date, period:k.period, subject:k.subject, folder:"", files:[], ignored:{}, manual:{}, savedAt:null};
    return drafts[dkey(k)];
  }
  function isDraft(t){ return !t.savedAt; }

  function render(){
    const cur = sel(); cur.cls = curCls();          // 先读旧选择器值，避免重建 DOM 丢选择
    const subs = subjectsFor(curCls());
    /* 定位到历史记录时，其节次/科目可能已不在当前候选里，也要能正常显示 */
    const pOpts = periods.includes(cur.period)? periods : [cur.period].concat(periods);
    const sOpts = subs.includes(cur.subject)? subs : [cur.subject].concat(subs);
    $("#page-body").innerHTML = `
      <div class="toolbar" style="margin-bottom:12px;flex-wrap:wrap">
        <input id="hr-date" type="date" value="${cur.date}" title="作业日期（默认今天）">
        <select id="hr-period" title="节次">${pOpts.map(x=>`<option ${x===cur.period?"selected":""}>${esc(x)}</option>`).join("")}</select>
        <select id="hr-sub" title="科目（联动教师账号管理·学科字段）">${sOpts.map(x=>`<option ${x===cur.subject?"selected":""}>${esc(x)}</option>`).join("")}</select>
        <button class="btn btn-primary" id="hr-pick">📂 选择作业文件夹</button>
        <input type="file" id="hr-dir" webkitdirectory multiple style="display:none">
        <button class="btn" id="hr-xls-pick" title="导入 Excel 名单（.xlsx / .csv），按姓名或学号自动匹配提交情况">📊 导入 Excel 名单</button>
        <input type="file" id="hr-xls" accept=".xlsx,.xlsm,.xls,.csv,.txt" style="display:none">
        <button class="btn btn-ok" id="hr-commit"></button>
        <span id="hr-status"></span>
      </div>
      <div class="cards c4" id="hr-stats"></div>
      <div class="toolbar" style="margin:0 0 8px">
        <button class="btn btn-sm ${filter==="all"?"btn-primary":""}" data-f="all">全部</button>
        <button class="btn btn-sm ${filter==="ok"?"btn-primary":""}" data-f="ok">已交</button>
        <button class="btn btn-sm ${filter==="no"?"btn-primary":""}" data-f="no">未交</button>
        <span class="muted" style="font-size:12px">点击表头排序 · 点击学生姓名查看历史提交 · 连2次未交橙色 / 连3次红色</span>
      </div>
      ${panel(`作业完成记录表 · ${esc(curCls())}`, `<div class="table-wrap"><table class="data">
        <thead><tr><th data-k="no">序号</th><th data-k="name">姓名</th><th data-k="sid">学号</th>
        <th data-k="status">提交状态</th><th>提交的文件（悬停看完整路径）</th><th data-k="time">文件修改时间</th><th>操作</th></tr></thead>
        <tbody id="hr-tbody"></tbody></table></div>`, "", true)}
      <div id="hr-unwrap"></div>
      <div id="hr-history"></div>`;
    bindToolbar();
    renderTable();
    renderHistory();
  }
  function bindToolbar(){
    ["hr-date","hr-period","hr-sub"].forEach(id=>{ const el=$("#"+id); if(el) el.onchange=render; });
    $("#hr-pick").onclick = ()=>$("#hr-dir").click();
    $("#hr-dir").onchange = e=>{
      const fs=[...e.target.files]; e.target.value=""; if(!fs.length) return;
      const files = fs.map(f=>({ name:f.name, rel:f.webkitRelativePath||f.name, size:f.size, mtime:f.lastModified }));
      const folder = files[0].rel.split("/")[0] || "已选文件夹";
      const t = target();
      const apply = ()=>{
        const keepSheet = (t.files||[]).filter(f=>f.fromSheet);   // 保留已导入的 Excel 名单条目
        t.folder=folder; t.files=files.concat(keepSheet); t.ignored={}; t.manual={};
        if(!isDraft(t)){ t.savedAt=Date.now(); save(); toast(`已读取 ${files.length} 个文件，该条记录已更新`); }
        else toast(`已读取 ${files.length} 个文件，匹配完成。确认后点「汇入记录表」`);
        filter="all"; sortKey="no"; sortDir=1; render();
      };
      if((t.files||[]).length) confirmBox("当前已选过作业内容，重新选择将覆盖原有文件与手工修正（Excel 名单保留），确认继续？", apply);
      else apply();
    };
    /* Excel 名单导入（.xlsx / .csv）：按姓名或学号自动匹配提交情况 */
    $("#hr-xls-pick").onclick = ()=>$("#hr-xls").click();
    $("#hr-xls").onchange = e=>{
      const f = e.target.files[0]; e.target.value="";
      if(f) importSheet(f);
    };
    updateCommit();
    $("#hr-commit").onclick = ()=>{
      const k = sel(); k.cls = curCls();
      const t = target();
      if(!(t.files||[]).length && !t.sheet){ toast("请先选择作业文件夹，或导入 Excel 名单再汇入", true); return; }
      const doIt = ()=>{
        const ex = savedByKey(k);
        if(ex){ Object.assign(ex,{folder:t.folder,files:t.files,ignored:t.ignored,manual:t.manual,sheet:t.sheet,savedAt:Date.now()}); toast("✓ 该条记录已更新"); }
        else{
          hwSessions().push({id:uid("HW"), cls:k.cls, date:k.date, period:k.period, subject:k.subject,
            folder:t.folder, files:t.files, ignored:t.ignored||{}, manual:t.manual||{}, sheet:t.sheet||null, savedAt:Date.now()});
          toast("✓ 已汇入作业完成记录表");
        }
        delete drafts[dkey(k)];
        filter="all"; sortKey="no"; sortDir=1;
        save(); render();
      };
      if(savedByKey(k)) confirmBox("该日期 / 节次 / 科目已有记录，汇入将覆盖原记录（含手工修正），确认继续？", doIt);
      else doIt();
    };
    document.querySelectorAll("#page-body [data-f]").forEach(b=>b.onclick = ()=>{
      filter = b.dataset.f;
      document.querySelectorAll("#page-body [data-f]").forEach(x=>x.classList.toggle("btn-primary", x.dataset.f===filter));
      renderTable();
    });
    document.querySelectorAll("#page-body th[data-k]").forEach(th=>th.onclick = ()=>{
      const k = th.dataset.k;
      if(sortKey===k) sortDir*=-1; else { sortKey=k; sortDir=1; }
      renderTable();
    });
  }
  /* ---------- 导入 Excel 名单：按姓名 / 学号匹配提交情况 ---------- */
  function importSheet(file){
    const t = target();
    toast("⏳ 正在解析 " + file.name + " …");
    readTableGrid(file).then(grid=>{
      const st = state.students.filter(s=>s.cls===curCls());
      if(!st.length){ toast("该班还没有学生名单，请先在「学生档案」录入学生", true); return; }
      const det = sheetDetect(grid, st);
      if(!det){ toast("未能识别姓名列：请在表格中保留「姓名」表头（或姓名与本班学生一致）", true); return; }
      const at = Date.now();
      const keep = det.rows.filter(r=>r.status !== false);      // 标注"未交"的行不计入提交
      const skipN = det.rows.length - keep.length;
      const sheetFiles = keep.map((r,i)=>{
        const label = r.name || r.sid || ("第"+(i+1)+"行");
        return { name: label+"（Excel名单）", short:label, rel:"Excel名单/"+label,
                 size:null, mtime:at, fromSheet:true, sheetFile:file.name, rawSt:r.rawSt||"" };
      });
      const apply = ()=>{
        /* 替换上一次的名单条目，保留文件夹里的真实作业文件与手工修正 */
        const rels = new Set(sheetFiles.map(f=>f.rel));
        t.files = (t.files||[]).filter(f=>!f.fromSheet).concat(sheetFiles);
        Object.keys(t.manual||{}).forEach(n=>{
          t.manual[n] = (t.manual[n]||[]).filter(f=>!f.fromSheet || rels.has(f.rel));
        });
        t.sheet = { file:file.name, at:at, cols:{name:det.nameCol, id:det.idCol, status:det.stCol}, rows:det.rows };
        const m = hwMatch(t);
        const ok = m.rows.filter(x=>!t.ignored[x.s.name] && x.sub).length;
        const sum = `${det.rows.length} 行 · ${ok} 人已交${skipN?(" · "+skipN+" 行标注未交"):""}${m.unmatched.length?(" · "+m.unmatched.length+" 行未匹配"):""}`;
        if(!isDraft(t)){ t.savedAt = Date.now(); save(); toast("✓ 名单已更新："+sum); }
        else toast("已读取名单（"+sum+"），确认后点「汇入记录表」");
        filter="all"; sortKey="no"; sortDir=1; render();
      };
      if(t.sheet) confirmBox(`将替换上次导入的名单「${t.sheet.file}」（文件夹中的作业文件与手工修正保留），确认继续？`, apply);
      else apply();
    }).catch(e=>toast("表格解析失败："+e.message, true));
  }
  function updateCommit(){
    const t = target();
    const realN = (t.files||[]).filter(f=>!f.fromSheet).length;
    const sheetN = (t.files||[]).filter(f=>f.fromSheet).length;
    const src = [t.folder?("文件夹 "+t.folder+" · "+realN+" 个文件"):"",
                 t.sheet?("Excel 名单 "+t.sheet.file+" · "+t.sheet.rows.length+" 行"+(sheetN?"（已计入 "+sheetN+" 行）":"")):""
                ].filter(Boolean).join(" ｜ ") || "尚未选择作业文件夹或导入 Excel 名单";
    $("#hr-commit").textContent = isDraft(t) ? "📥 汇入记录表" : "💾 保存此记录";
    $("#hr-status").innerHTML = isDraft(t)
      ? `<span class="tag warn">草稿 · 未入表</span> <span class="muted" style="font-size:12px">${esc(src)}</span>`
      : `<span class="tag green">✓ 已入表 · ${hwTime(t.savedAt)}</span> <span class="muted" style="font-size:12px">${esc(src)}</span>`;
  }
  function renderTable(){
    const t = target();
    const { st, auto, unmatched } = hwMatch(t);
    const rows = st.filter(s=>!t.ignored[s.name]).map((s,i)=>({
      s, no:i+1, man:(t.manual[s.name]||[]),
      files:(auto[s.name]||[]).concat(t.manual[s.name]||[]),
    }));
    rows.forEach(r=>{ r.sub=r.files.length>0; r.manualOnly=!(auto[r.s.name]||[]).length&&r.man.length>0;
      r.real=r.files.filter(f=>!f.fromSheet);                       // 真实作业文件
      r.last=r.real.reduce((m,f)=>Math.max(m,f.mtime||0),0); });
    rows.sort((a,b)=>{
      let r=0;
      if(sortKey==="no") r=a.no-b.no;
      else if(sortKey==="name") r=a.s.name.localeCompare(b.s.name,"zh-Hans-CN");
      else if(sortKey==="sid") r=String(a.s.id||"").localeCompare(String(b.s.id||""),"zh-Hans-CN",{numeric:true});
      else if(sortKey==="status") r=(a.sub?1:0)-(b.sub?1:0);
      else if(sortKey==="time") r=a.last-b.last;
      return r*sortDir;
    });
    const igN = st.length-rows.length;
    const ok = rows.filter(r=>r.sub).length;
    const rate = rows.length? (ok/rows.length*100).toFixed(1)+"%" : "—";
    $("#hr-stats").innerHTML =
      statCard("总人数", rows.length, "", igN?`另有 ${igN} 人已忽略`:"不含已忽略学生")+
      statCard("已交", ok+" <small>人</small>", "green", t.sheet? "含 Excel 名单匹配" : "自动匹配 + 手动指定")+
      statCard("未交", (rows.length-ok)+" <small>人</small>", rows.length-ok?"danger":"green","可在操作列指定文件")+
      statCard("提交率", rate, "accent", `${esc(t.date)} ${esc(t.period)} · ${esc(t.subject)}`);
    $("#hr-tbody").innerHTML = rows.filter(r=>filter==="all"||r.sub===(filter==="ok")).map((r,i)=>{
      /* 两种来源：蓝色标签 = 作业文件；紫色标签 = Excel 名单中的一行 */
      const chipOf = f => f.fromSheet
        ? `<span class="tag purple" title="来自 Excel 名单${f.sheetFile?("："+f.sheetFile):""}${f.rawSt?("（状态列："+f.rawSt+"）"):""}">📊 ${esc(f.short||f.name)}</span>`
        : `<span class="tag blue" title="${esc(f.rel)}（${hwSize(f.size)} · ${hwTime(f.mtime)}）">${esc(f.name)}</span>`;
      const shown = r.real.concat(r.files.filter(f=>f.fromSheet));   // 作业文件在前，名单在后
      const chips = shown.length
        ? shown.slice(0,3).map(chipOf).join(" ")
          + (shown.length>3?` <span class="muted" style="font-size:11px;cursor:help" title="${esc(shown.map(f=>f.rel).join("\n"))}">+${shown.length-3} 更多</span>`:"")
        : `<span class="muted">—</span>`;
      const ops = r.sub
        ? (r.man.length?`<span class="link" data-unman="${esc(r.s.name)}">移除手动</span> `:"")+`<span class="link" data-ign="${esc(r.s.name)}">忽略</span>`
        : `<span class="link" data-assign="${esc(r.s.name)}">指定文件</span> <span class="link" data-ign="${esc(r.s.name)}">忽略</span>`;
      return `<tr>
        <td>${i+1}</td><td><span class="link" data-hist="${esc(r.s.name)}">${hwNameHTML(curCls(), t.subject, r.s.name)}</span></td><td>${esc(r.s.id||"—")}</td>
        <td><span class="tag ${r.sub?"green":"red"}">${r.sub?"已交":"未交"}</span>${r.manualOnly?` <span class="tag warn">手动</span>`:""}</td>
        <td style="max-width:420px"><div style="display:flex;flex-wrap:wrap;gap:4px">${chips}</div></td>
        <td>${r.last?hwTime(r.last):"—"}</td><td style="white-space:nowrap">${ops}</td></tr>`;
    }).join("") || `<tr><td colspan="7"><div class="empty">${st.length?"当前筛选下没有学生":"该班还没有学生名单，请先在学生档案中录入"}</div></td></tr>`;
    if(filter==="all"){
      const ig = st.filter(s=>t.ignored[s.name]);
      if(ig.length) $("#hr-tbody").innerHTML += ig.map(s=>`<tr style="opacity:.45">
        <td>—</td><td>${esc(s.name)}</td><td>${esc(s.id||"—")}</td>
        <td><span class="tag">已忽略</span></td><td class="muted">不计入统计</td><td>—</td>
        <td><span class="link" data-unign="${esc(s.name)}">恢复</span></td></tr>`).join("");
    }
    /* 未匹配内容（文件夹里未归类的文件 + Excel 名单里没匹配到学生的行） */
    $("#hr-unwrap").innerHTML = panel(`未匹配内容（文件名 / Excel 名单中未找到对应学生）${unmatched.length?`<span class="tag warn" style="margin-left:8px">${unmatched.length} 条</span>`:""}`,
      !(t.files||[]).length
        ? `<div class="empty">请先选择作业文件夹，或点「📊 导入 Excel 名单」</div>`
        : unmatched.length
          ? `<div class="table-wrap"><table class="data"><thead><tr><th>名称</th><th>大小</th><th>时间</th><th>操作</th></tr></thead><tbody>`+
            unmatched.map(f=> f.fromSheet
              ? `<tr><td title="来自 Excel 名单${f.sheetFile?("："+esc(f.sheetFile)):""}">📊 ${esc(f.short||f.name)}</td><td>—</td><td>${hwTime(f.mtime)}</td>
                  <td><span class="link" data-fassign="${esc(f.rel)}">指定给学生</span></td></tr>`
              : `<tr><td title="${esc(f.rel)}">${esc(f.name)}</td><td>${hwSize(f.size)}</td><td>${hwTime(f.mtime)}</td>
                  <td><span class="link" data-fassign="${esc(f.rel)}">指定给学生</span></td></tr>`).join("")+`</tbody></table></div>`
          : `<div class="empty">没有未匹配内容，${(t.files||[]).length} 条记录已全部归类</div>`);
    /* 行内事件 */
    const persist = ()=>{ if(!isDraft(t)) save(); renderTable(); updateCommit(); };
    $("#hr-tbody").querySelectorAll("[data-hist]").forEach(el=>el.onclick=()=>stuHistory(el.dataset.hist));
    $("#hr-tbody").querySelectorAll("[data-assign]").forEach(el=>el.onclick=()=>assignModal(el.dataset.assign));
    $("#hr-tbody").querySelectorAll("[data-ign]").forEach(el=>el.onclick=()=>{ t.ignored[el.dataset.ign]=1; persist(); toast(`已忽略 ${el.dataset.ign}`); });
    $("#hr-tbody").querySelectorAll("[data-unign]").forEach(el=>el.onclick=()=>{ delete t.ignored[el.dataset.unign]; persist(); toast(`已恢复 ${el.dataset.unign}`); });
    $("#hr-tbody").querySelectorAll("[data-unman]").forEach(el=>el.onclick=()=>{ t.manual[el.dataset.unman]=[]; persist(); toast(`已移除 ${el.dataset.unman} 的手动指定文件`); });
    $("#hr-unwrap").querySelectorAll("[data-fassign]").forEach(el=>el.onclick=()=>assignFileModal(el.dataset.fassign));
  }
  /* 学生历史提交记录（点击姓名） */
  function stuHistory(name){
    const cls = curCls(), k = sel(); k.cls = cls;
    const list = hwSessions().filter(s=>s.cls===cls).sort((a,b)=>(a.date+a.period).localeCompare(b.date+b.period));
    const total = list.length, ok = list.filter(r=>hwIsSubmitted(r,name)).length;
    const streak = hwMissStreak(cls, k.subject, name);
    modal(`${name} · 作业提交历史`, `
      <div class="cards c3" style="margin-bottom:12px">
        ${statCard("记录次数", total+" <small>次</small>")}
        ${statCard("已交 / 未交", ok+" / "+(total-ok), total&&ok/total>=.6?"green":"warn")}
        ${statCard("当前连续未交", streak+" <small>次</small>", streak>=3?"danger":streak===2?"warn":"green", "科目："+esc(k.subject))}
      </div>
      ${list.length ? tableHTML(["日期","节次","科目","状态","文件"],
        list.slice().reverse().map(r=>{
          const all = (hwMatch(r).auto[name]||[]).concat((r.manual||{})[name]||[]);
          return [r.date, esc(r.period), esc(r.subject),
            hwIsSubmitted(r,name)?`<span class="tag green">已交</span>`:`<span class="tag red">未交</span>`,
            all.length? `<span class="tag blue" title="${esc(all.map(f=>f.rel).join("\n"))}">${all.length} 个</span>`:`<span class="muted">—</span>`];
        }), {noSort:true}) : `<div class="empty">该班还没有已汇入的作业记录</div>`}`,
      [{text:"关闭"}]);
  }
  /* 历史记录表：按月 / 按年查询与导出 */
  function filteredList(){
    const ym = $("#hr-qmonth")?.value || "", yr = $("#hr-qyear")?.value || "";
    let list = hwSessions().filter(s=>s.cls===curCls());
    if(ym) list = list.filter(s=>s.date.startsWith(ym));
    if(yr) list = list.filter(s=>s.date.startsWith(yr));
    return list.sort((a,b)=>(b.date+b.period).localeCompare(a.date+a.period));
  }
  function renderHistory(){
    const years = [...new Set(hwSessions().filter(s=>s.cls===curCls()).map(s=>s.date.slice(0,4)))].sort().reverse();
    const curYr = String(new Date().getFullYear());
    if(!years.includes(curYr)) years.push(curYr);
    const yr = $("#hr-qyear")?.value || "";
    const list = filteredList();
    $("#hr-history").innerHTML = panel(`作业汇总表 · ${esc(curCls())} <span class="muted" style="font-size:12px">每次授课汇入一条，支持查看 / 修改 / 删除，可按月 / 按年查询导出</span>`, `
      <div class="toolbar">
        <input id="hr-qmonth" type="month" value="${$("#hr-qmonth")?.value||""}" title="按月查询">
        <select id="hr-qyear" title="按年查询"><option value="">全部年份</option>${years.map(y=>`<option ${y===yr?"selected":""}>${y}</option>`).join("")}</select>
        <button class="btn" id="hr-exp-m">📤 按月导出 CSV</button>
        <button class="btn" id="hr-exp-y">📤 按年导出 CSV</button>
        <span class="muted" style="font-size:12px">共 ${list.length} 条记录</span>
      </div>
      ${list.length ? tableHTML(["日期","节次","科目","文件数","提交情况","保存时间","操作"],
        list.map(r=>{
          const m = hwMatch(r);
          const tot = m.rows.filter(x=>!r.ignored[x.s.name]).length;
          const ok = m.rows.filter(x=>!r.ignored[x.s.name]&&x.sub).length;
          const cur = target();
          const realN = (r.files||[]).filter(f=>!f.fromSheet).length;
          const sheetN = (r.files||[]).length - realN;
          return [r.date, esc(r.period), esc(r.subject),
            `${realN}${sheetN?` <span class="tag purple" style="padding:1px 6px">📊 名单 ${sheetN}</span>`:""}`,
            `<span class="tag green">${ok}</span><span class="tag red">${tot-ok}</span> <span class="muted" style="font-size:11px">${tot?(ok/tot*100).toFixed(0)+"%":"—"}</span>`,
            hwTime(r.savedAt),
            `<span class="link" data-hview="${r.id}">查看</span> <span class="link" data-hedit="${r.id}">修改</span> <span class="link" style="color:var(--danger)" data-hdel="${r.id}">删除</span>`];
        }), {noSort:true}) : `<div class="empty"><span class="eico">🗂️</span>所选范围暂无记录：选择文件夹并点「汇入记录表」即可生成</div>`}`);
    ["hr-qmonth","hr-qyear"].forEach(id=>{ const el=$("#"+id); if(el) el.onchange=renderHistory; });
    $("#hr-exp-m").onclick = ()=>exportBy("m");
    $("#hr-exp-y").onclick = ()=>exportBy("y");
    /* 定位到某条记录：把顶部三个选择器切过去，主表即为该记录，可继续编辑 */
    const gotoRecord = r=>{
      $("#hr-date").value = r.date; $("#hr-period").value = r.period; $("#hr-sub").value = r.subject;
      filter="all"; render();
      toast(`已定位到 ${r.date} ${r.period} ${r.subject}，修改后点「汇入记录表」覆盖更新`);
    };
    /* 查看：只读明细弹窗（谁交了 / 谁没交 / 交了什么文件） */
    $("#hr-history").querySelectorAll("[data-hview]").forEach(el=>el.onclick=()=>{
      const r = byId(el.dataset.hview); if(!r) return;
      const m = hwMatch(r);
      const kept = m.rows.filter(x=>!r.ignored[x.s.name]);
      const okN = kept.filter(x=>x.sub).length;
      modal(`作业记录明细 · ${r.date} ${r.period} ${r.subject} · ${r.cls}`,
        `<div class="cards c3" style="margin-bottom:10px">
          ${statCard("应提交", kept.length+" 人","", "已忽略 "+(m.rows.length-kept.length)+" 人")}
          ${statCard("已提交", okN+" 人","green", kept.length?(okN/kept.length*100).toFixed(0)+"% 提交率":"—")}
          ${statCard("未提交", (kept.length-okN)+" 人",(kept.length-okN)?"danger":"","未匹配 "+(m.unmatched.length)+" 条")}
        </div>`
        + (r.sheet?`<p class="muted" style="margin-bottom:8px">📊 Excel 名单：${esc(r.sheet.file)} · ${r.sheet.rows.length} 行${r.sheet.cols&&r.sheet.cols.status>=0?"（含状态列）":""}</p>`:"")
        + tableHTML(["姓名","状态","提交的文件 / 名单"],
          kept.map(x=>[esc(x.s.name), x.sub?`<span class="tag green">已交</span>`:`<span class="tag red">未交</span>`,
            x.files.length? x.files.map(f=> f.fromSheet
                ? `<span class="tag purple" title="Excel 名单匹配">📊 ${esc(f.short||f.name)}</span>`
                : `<span class="tag blue" title="${esc(f.rel)}">${esc(f.name)}</span>`).join(" ")
              : `<span class="muted">—</span>`]),
          {noSort:true}),
        [{text:"关闭"},{text:"修改此记录",cls:"btn-primary",fn:()=>gotoRecord(r)}]);
    });
    /* 修改：切换到该记录（顶部选择器联动 + 主表可编辑 + 可覆盖汇入） */
    $("#hr-history").querySelectorAll("[data-hedit]").forEach(el=>el.onclick=()=>{
      const r = byId(el.dataset.hedit); if(!r) return;
      gotoRecord(r);
    });
    /* 删除：二次确认后移除该条记录 */
    $("#hr-history").querySelectorAll("[data-hdel]").forEach(el=>el.onclick=()=>{
      const r = byId(el.dataset.hdel); if(!r) return;
      const m = hwMatch(r);
      const okN = m.rows.filter(x=>!r.ignored[x.s.name]&&x.sub).length;
      confirmBox(`删除作业记录「${r.date} ${r.period} ${r.subject}」（${(r.files||[]).length} 个文件、已交 ${okN} 人）？此操作不可恢复。`, ()=>{
        state.hwSessions = hwSessions().filter(x=>x.id!==r.id);
        delete drafts[dkey({cls:r.cls,date:r.date,period:r.period,subject:r.subject})];
        save(); toast("作业记录已删除"); render();
      });
    });
  }
  function byId(id){ return hwSessions().find(s=>s.id===id); }
  function exportBy(kind){
    const ym = $("#hr-qmonth")?.value || "", yrEl = $("#hr-qyear");
    let list = hwSessions().filter(s=>s.cls===curCls());
    let tag;
    if(kind==="m"){ if(!ym){ toast("请先选择要导出的月份", true); return; } list=list.filter(s=>s.date.startsWith(ym)); tag=ym; }
    else{ const y = yrEl?.value || String(new Date().getFullYear()); list=list.filter(s=>s.date.startsWith(y)); tag=y; }
    if(!list.length){ toast("所选范围暂无记录", true); return; }
    const rows=[];
    list.sort((a,b)=>(a.date+a.period).localeCompare(b.date+b.period)).forEach(r=>{
      hwMatch(r).rows.forEach(x=>{
        if(r.ignored[x.s.name]) return;
        rows.push([r.date, r.period, r.subject, r.cls, x.s.name, x.sub?"已交":"未交", x.files.map(f=>f.rel).join(" ; ")]);
      });
    });
    exportCSV(`作业记录_${curCls()}_${tag}`, ["日期","节次","科目","班级","姓名","状态","提交文件"], rows);
  }
  /* 手动修正：为学生勾选未匹配文件 */
  function assignModal(name){
    const { unmatched } = hwMatch(target());
    if(!unmatched.length){ toast("文件夹中没有未匹配文件可指定", true); return; }
    const m = modal(`为「${esc(name)}」指定文件`,
      `<div style="max-height:340px;overflow:auto">${unmatched.map((f,i)=>`
        <label style="display:flex;gap:8px;align-items:center;padding:7px 4px;border-bottom:1px dashed var(--border);cursor:pointer">
          <input type="checkbox" data-i="${i}">
          <span>${esc(f.name)} <span class="muted" style="font-size:11px">${hwSize(f.size)} · ${hwTime(f.mtime)}<br>${esc(f.rel)}</span></span>
        </label>`).join("")}</div>`,
      [{text:"取消"},{text:"确认指定",cls:"btn-primary",fn:()=>{
        const t = target();
        const picks = [...m.el.querySelectorAll("input:checked")].map(x=>unmatched[+x.dataset.i]);
        if(!picks.length){ toast("请先勾选文件", true); return false; }
        t.manual[name] = (t.manual[name]||[]).concat(picks);
        if(!isDraft(t)) save();
        toast(`已为 ${name} 指定 ${picks.length} 个文件`); renderTable();
      }}]);
  }
  /* 手动修正：把未匹配文件指派给学生 */
  function assignFileModal(rel){
    const t = target();
    const cands = state.students.filter(s=>s.cls===curCls() && !t.ignored[s.name]);
    if(!cands.length){ toast("该班没有可选学生", true); return; }
    const m = modal("将该文件指定给学生",
      `<label>选择学生 <select id="fa-stu">${cands.map(s=>`<option value="${esc(s.name)}">${esc(s.name)}（${esc(s.id||"无学号")}）</option>`).join("")}</select></label>
       <p class="muted" style="margin-top:8px;font-size:12px">${esc(rel)}</p>`,
      [{text:"取消"},{text:"确认",cls:"btn-primary",fn:()=>{
        const name = m.el.querySelector("#fa-stu").value;
        const f = t.files.find(x=>x.rel===rel); if(!f) return;
        t.manual[name] = (t.manual[name]||[]).concat([f]);
        if(!isDraft(t)) save();
        toast(`已将 ${f.name} 指定给 ${name}`); renderTable();
      }}]);
  }
};

/* ---------- 启动 ---------- */
loadState();
session = (()=>{ try{ return JSON.parse(localStorage.getItem("twb_session")); }catch(e){ return null; } })();
initLogin();
if(session){
  // 超管会话不持久化（每次登录必须重新输入）；教师/学生会话需校验账号仍有效
  const valid = session.role==="student"
    ? !!state.students.find(s=>s.name===session.name)
    : !!state.users.find(u=>u.account===session.account);
  if(valid) enterApp(); else { session=null; localStorage.removeItem("twb_session"); }
}
// 启动云端同步（已配置时）：拉取/上传最新数据 + 定时轮询云端更新
cloudBoot(); startCloudPoll();
