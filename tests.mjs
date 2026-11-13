/* tests.mjs —— 甲骨 C++ 编译器与贪吃蛇的自动回归测试 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JCP = path.join(HERE, "jcp.mjs");

function run(file, input, argv) {
  const args = argv ? [JCP, ...argv] : [JCP, file, "--quiet"];
  const r = spawnSync(process.execPath, args, {
    input: input || "",
    encoding: "utf8",
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", signal: r.signal };
}

const CASES = [
  { name: "三加二", file: "san.jcp", expect: { code: 0, out: ["大吉"] } },
  { name: "大有年", file: "tian.jcp", expect: { code: 0, out: ["大有年"] } },
  { name: "卜雨", file: "bu.jcp", expect: { code: 0, out: ["合", "雨"] } },
  { name: "復循环", file: "xun.jcp", expect: { code: 0, out: ["0\n1\n2"] } },
  { name: "作天人", file: "han.jcp", expect: { code: 0, out: ["5", "合"] } },
  { name: "從循环", file: "cong.jcp", expect: { code: 0, out: ["0\n1\n2"] } },
  { name: "数组读写", file: "t-arr.jcp", expect: { code: 0, out: ["9", "14"] } },
  { name: "书与占断", file: "t-book.jcp", expect: { code: 0, out: ["甲骨", "A", "合"] } },
  { name: "越界报错", file: "t-bound.jcp", expect: { code: 1, err: ["数组越界"] } },
  { name: "除零报错", file: "t-div0.jcp", expect: { code: 1, err: ["除以零"] } },
  { name: "蛇·立即退出", file: "snake.jcp", input: "q", expect: { code: 0, out: ["長：3", "亡"] } },
  { name: "蛇·吃食成长", file: "snake.jcp", input: "waaaq", expect: { code: 0, out: ["長：4", "亡"] } },
  { name: "蛇·撞墙", file: "snake.jcp", input: "ddddddddq", expect: { code: 0, out: ["亡"] } },
  { name: "蛇·无效键不动作", file: "snake.jcp", input: "xq", expect: { code: 0, out: ["長：3", "亡"] } },
  { name: "蛇·输入结束", file: "snake.jcp", input: "", expect: { code: 0, out: ["亡"] } },
  { name: "蛇·自撞", file: "snake.jcp", input: "waaaswwwasdaaaasdwaq", expect: { code: 0, out: ["長：6", "亡"] } },
  { name: "蛇·追尾合法", file: "snake.jcp", input: "waaasdwq", expect: { code: 0, out: ["長：4", "亡"] } },
  { name: "数组长度非法", file: "t-arrsize.jcp", expect: { code: 1, err: ["数组长度非法"] } },
  { name: "递归过深", file: "t-rec.jcp", expect: { code: 1, err: ["调用层级过深"] } },
  { name: "缺少入口", file: "t-noentry.jcp", expect: { code: 3, err: ["缺少入口函数"] } },
  { name: "重复定义", file: "t-dup.jcp", expect: { code: 3, err: ["函数重复定义"] } },
  { name: "竖排源·三加二", file: "san.jcpv", expect: { code: 0, out: ["大吉"] } },
  { name: "工作台·编写编译运行", argv: ["--workbench"], input: ":demo 三加二\n:run\n", expect: { code: 0, out: ["大吉", "退出碼 0"] } },
  { name: "竖排显示", argv: ["san.jcp", "--vertical"], expect: { code: 0, out: ["量", "貞"] } },
  { name: "新算子·隹益去乘分不隹", file: "t-op.jcp", expect: { code: 0, out: ["5", "6", "吉", "合"] } },
  { name: "旧写法兼容", file: "t-legacy.jcp", expect: { code: 0, out: ["5"] } },
  { name: "多位数", file: "t-num.jcp", expect: { code: 0, out: ["16", "25", "吉"] } },
  { name: "止 break", file: "t-break.jcp", expect: { code: 0, out: ["到五", "5"] } },
  { name: "且/或", file: "t-logic.jcp", expect: { code: 0, out: ["且", "或"] } },
  { name: "续 continue", file: "t-continue.jcp", expect: { code: 0, out: ["1\n2\n4\n5", "完", "0\n1\n3\n4"] } },
  { name: "模块 引 學", file: "t-module.jcp", expect: { code: 0, out: ["5\n3\n16\n7\n1"] } },
  { name: "常量 恒", file: "t-const.jcp", expect: { code: 0, out: ["8", "9"] } },
  { name: "常量不可赋值", file: "t-const-err.jcp", expect: { code: 3, err: ["常量「甲」不可赋值"] } },
  { name: "标准库 引 學/兆", file: "t-stdlib.jcp", expect: { code: 0, out: ["9", "12"] } },
  { name: "类型：浮点/字符串/布尔", file: "t-types.jcp", expect: { code: 0, out: ["3.14", "5.14", "6.28", "甲骨C++", "同", "吉", "非", "或"] } },
  { name: "类型化数组", file: "t-arrtypes.jcp", expect: { code: 0, out: ["1.5", "甲", "吉"] } },
  { name: "类型错误", file: "t-typeerr.jcp", expect: { code: 3, err: ["不能接收 string"] } },
  { name: "字符串库 文長/取文/解文/解浮", file: "t-strlib.jcp", expect: { code: 0, out: ["5", "骨C+", "42", "3.5"] } },
  { name: "数组作函数参数", file: "t-arraypass.jcp", expect: { code: 0, out: ["15"] } },
  { name: "标准库数组函数 共", file: "t-arraylib.jcp", expect: { code: 0, out: ["6"] } },
  { name: "自动生成程序PNG", png: true, expect: { code: 0, out: ["已生成"] } },
  { name: "GUI 本地服务", helper: "test-gui.mjs", expect: { code: 0, out: ["run:", "\"ok\":true", "ac-ok"] } },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const problems = [];
  let r;
  if (c.helper) {
    const rr = spawnSync(process.execPath, [path.join(HERE, c.helper)], { encoding: "utf8", timeout: 180000 });
    r = { code: rr.status, out: rr.stdout || "", err: rr.stderr || "", signal: rr.signal };
  } else if (c.png) {
    const outP = path.join(HERE, "build", "test-auto.png");
    try { fs.unlinkSync(outP); } catch (e) {}
    const rr = spawnSync(process.execPath, [JCP, "png", "san.jcp", "-o", outP], { encoding: "utf8", timeout: 180000 });
    r = { code: rr.status, out: rr.stdout || "", err: rr.stderr || "", signal: rr.signal };
    if (fs.existsSync(outP)) {
      const buf = fs.readFileSync(outP);
      if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") problems.push("PNG 魔数不对");
      if (buf.length < 50000) problems.push("PNG 文件过小（" + buf.length + " 字节）");
    } else problems.push("PNG 文件未生成");
  } else {
    r = run(c.file, c.input, c.argv);
  }
  if (r.code !== c.expect.code) problems.push("退出码 " + r.code + " ≠ " + c.expect.code);
  for (const s of c.expect.out || []) if (!r.out.includes(s)) problems.push("输出缺少「" + s.replace(/\n/g, "\\n") + "」");
  for (const s of c.expect.err || []) if (!r.err.includes(s)) problems.push("错误输出缺少「" + s + "」");
  if (r.signal) problems.push("进程被信号终止 " + r.signal);
  if (problems.length) {
    fail++;
    console.log("FAIL  " + c.name + "\n      " + problems.join("\n      "));
    if (r.err) console.log("      stderr: " + r.err.trim().split("\n").slice(-3).join(" | "));
  } else {
    pass++;
    console.log("ok    " + c.name);
  }
}
console.log("\n结果：" + pass + " 通过 · " + fail + " 失败");
process.exit(fail ? 1 : 0);
