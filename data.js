/* ============ 数据结构（默认为空，由用户自行录入） ============ */
// 系统不预置任何虚构业务数据；登录账号为使用入口，业务数据全部由真实使用产生。
const SEED = (() => {
  return {
    students: [],        // 学生档案 {id, cls, name, gender, guardian, phone, tags, remark}
    classes: [],         // 班级 [{id, name, headteacher}]，学生账号=姓名，密码 123456
    exams: [],           // 考试
    subjects: ["语文","数学","英语","物理"],
    fulls: {语文:100, 数学:100, 英语:100, 物理:80},
    scores: {},          // examId -> cls -> {name:{subj:score}}
    notices: [],         // 通知/作业
    comms: [],           // 沟通记录
    morals: [],          // 德育记录
    timetable: {},       // 周课表：{"周一":{"第1节":"初二(3)班·数学", ...}}
    periods: ["早自习","第1节","第2节","第3节","第4节","第5节","第6节","第7节"],
    periodTimes: {},     // 节次 -> 上课时间，如 {"第1节":"08:00-08:45"}
    rollcall: {},        // 点名记录
    points: [],          // 课堂积分流水
    notes: [],           // 学习笔记
    todos: [],           // 待办
    duties: [],          // 监考/值班/会议
    homework: [],        // 作业 {id, title, desc, cls, date, teacher}
    hws: [],             // 作业提交/批改 {id, hwId, cls, student, images:[dataURL], date, time, level, comment}
    tenant: {name:"我的学校", clsName:"我的班级", gradeTeacher:"", year:"2026-2027", term:"第一学期",
      room:"", groupQ:"", phone:"", motto:""},
    users: [],           // 教师账号 {id, name, account, password, role, subject, classes, status}（超级管理员创建）
    auditLogs: [],       // 操作日志
    shares: [],          // 分享授权
    aiLogs: [],
    stories: [],         // 教育故事
    problems: []         // 学生问题档案
  };
})();
