#!/usr/bin/env node
/* ============================================================================
 * 甲骨 C++ 编译器 jcp v0.6（现代版）
 *
 * 语言（甲骨 C++）：
 *   量 = int        無 = void       歸 = return      若/弗 = if/else
 *   復 = while      從 = for        言 = 输出        卜 = 占断（断言）
 *   吉 = 1          貞 = 入口函数（main）
 *   数组：量 名[长度];   读写：名[下标]（运行时越界检查）
 *   内建：屏() 清屏 · 书(值) 原样输出（不换行）· 听() 读一键 · 歇(毫秒) 等待
 *   数字：一…十（也接受 0-9）  字符串：「…」  注释：；开头
 *   算子：隹 赋值/相等（＝）  益 加（＋）  去 减（－）  乘 乘（×）  分 除（÷）  不隹 不等（≠）
 *   模块：引 學;（lib/學.jcp）    常量：恒 名 隹 值;
 *         < > <= >= && || % 仍用符号（旧写法 = + - * / == != 仍兼容）
 *
 * 流水线：词法 → 语法树 → 语义检查 → JCB1 字节码 → 异步虚拟机执行
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { spawnSync } from "node:child_process";
import http from "node:http";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = process.env.JCP_BUILD || path.join(HERE, "build");

/* ---------------------------- 现代编译器基础设施 ---------------------------- */
const VERSION = "0.10.0";
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (s, code) => (COLOR ? "\x1b[" + code + "m" + s + "\x1b[0m" : s);

class CompileError extends Error {
  constructor(msg, line, col) {
    super(msg);
    this.name = "CompileError";
    this.line = line;
    this.col = col;
  }
}

/* 甲骨字词算子：隹/益/去/乘/分/不 —— 单字成词，进词法时直接算 op */
const OPWORD = { "隹": "隹", "益": "益", "去": "去", "乘": "乘", "分": "分", "不": "不", "且": "&&", "或": "||" };

/* 字体字形集合（PNG 生成用）：SEA 打包时由 build-sea 注入 globalThis.__JCP_FONT_CHARS */
const SKILL_ORACLE = "C:\\\\Users\\\\wangy\\\\.dsh\\\\skills\\\\zhenren\\\\data\\\\oracle.json";
function loadFontSet() {
  if (globalThis.__JCP_FONT_CHARS) return new Set(globalThis.__JCP_FONT_CHARS);
  const cands = [process.env.JCP_ORACLE, SKILL_ORACLE, path.join(HERE, "oracle.json")];
  for (const f of cands) {
    try {
      if (f && fs.existsSync(f)) {
        const o = JSON.parse(fs.readFileSync(f, "utf8"));
        const g = o.glyphs || o;
        const set = new Set();
        for (const [c, v] of Object.entries(g)) if (v && v.source === "font") set.add(c);
        return set;
      }
    } catch (e) {}
  }
  return new Set();
}
const FONT = loadFontSet();

/* ---------------------------- 词法 ---------------------------- */
const KW = { 量: "int", 無: "void", 歸: "return", 若: "if", 弗: "else", 復: "while", 從: "for", 言: "print", 卜: "assert", 止: "break", 续: "continue", 恒: "const", 引: "import", 字: "string", 占: "bool" };
const BOOLS = { 對: true, 非: false };
const NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 吉: 1 };
const NUMERAL_CHARS = "零一二三四五六七八九十百千兩";
const DIGIT = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT = { 十: 10, 百: 100, 千: 1000 };
function parseNumeral(word) {
  if (word.length === 1 && NUM[word] !== undefined) return NUM[word];
  let section = 0, num = 0;
  for (const ch of word) {
    if (DIGIT[ch] !== undefined) { num = DIGIT[ch]; continue; }
    if (UNIT[ch] !== undefined) {
      if (num === 0) num = 1;
      section += num * UNIT[ch];
      num = 0;
    }
  }
  return section + num;
}
const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "+", "-", "*", "/", "%",
  "=", "<", ">", "!", "(", ")", "{", "}", "[", "]", ";", ","];

function lex(src) {
  const t = [];
  let i = 0, line = 1, lineStart = 0;
  const add = (type, v, start) => t.push({ t: type, v, line, col: (start === undefined ? i : start) - lineStart + 1 });
  while (i < src.length) {
    const c = src[i];
    if (c === "\uFEFF") { i++; continue; }
    if (c === "\n") { line++; i++; lineStart = i; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "；" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "「") {
      const start = i;
      let s = "", j = i + 1;
      while (j < src.length && src[j] !== "」") s += src[j++];
      if (j >= src.length) throw new CompileError("字符串未闭合（缺少 」）", line, start - lineStart + 1);
      add("str", s, start); i = j + 1; continue;
    }
    if (NUMERAL_CHARS.includes(c)) {
      const start = i;
      let j = i;
      while (j < src.length && NUMERAL_CHARS.includes(src[j])) j++;
      if (j < src.length && src[j] === "·" && NUMERAL_CHARS.includes(src[j + 1])) {
        const intPart = parseNumeral(src.slice(i, j));
        let k = j + 1;
        while (k < src.length && NUMERAL_CHARS.includes(src[k])) k++;
        const fracWord = src.slice(j + 1, k);
        let fracNum = 0;
        for (let idx = 0; idx < fracWord.length; idx++) fracNum = fracNum * 10 + DIGIT[fracWord[idx]];
        const frac = fracNum / Math.pow(10, fracWord.length);
        const tok = { t: "num", v: intPart + frac, f: true, line, col: start - lineStart + 1 };
        t.push(tok); i = k; continue;
      }
      add("num", parseNumeral(src.slice(i, j)), start);
      i = j; continue;
    }
    if (NUM[c] !== undefined) { add("num", NUM[c]); i++; continue; }
    if (/[0-9]/.test(c)) {
      const start = i;
      let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1])) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
        t.push({ t: "num", v: parseFloat(src.slice(i, j)), f: true, line, col: start - lineStart + 1 });
        i = j; continue;
      }
      add("num", +src.slice(i, j), start); i = j; continue;
    }
    if (BOOLS[c] !== undefined) { add("bool", BOOLS[c]); i++; continue; }
    if (KW[c]) { add("kw", c); i++; continue; }
    let op = null;
    for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
    if (op) { add("op", op); i += op.length; continue; }
    if (OPWORD[c]) { add("op", OPWORD[c]); i++; continue; }
    if (/[A-Za-z_\u4e00-\u9fff]/.test(c)) {
      const start = i;
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\u4e00-\u9fff]/.test(src[j]) && !KW[src[j]] && !NUM[src[j]] && !OPWORD[src[j]]) j++;
      add("id", src.slice(i, j), start); i = j; continue;
    }
    throw new CompileError(`无法识别的字符「${c}」`, line, i - lineStart + 1);
  }
  add("eof", null);
  return t;
}

/* ---------------------------- 语法 ---------------------------- */
function parse(toks) {
  let p = 0;
  const peek = () => toks[p];
  const at = (t, v) => peek() && peek().t === t && (v === undefined || peek().v === v);
  const fail = (msg) => { const x = peek(); const where = x.v === null ? "文件结束" : x.v; throw new CompileError(msg + "（" + where + "）", x.line, x.col); };
  const eat = (t, v) => { if (!at(t, v)) fail(`期望 ${v || t}`); return toks[p++]; };

  function type() {
    if (at("kw", "量")) { p++; return "int"; }
    if (at("kw", "無")) { p++; return "void"; }
    if (at("kw", "字")) { p++; return "string"; }
    if (at("kw", "占")) { p++; return "bool"; }
    if (at("op", "分")) { p++; return "float"; }
    fail("期望类型 量/無/字/占/分");
  }
  function block() {
    eat("op", "{");
    const body = [];
    while (!at("op", "}")) body.push(stmt());
    eat("op", "}");
    return { t: "block", body };
  }
  function paramsOf() {
    eat("op", "(");
    const args = [];
    if (!at("op", ")")) for (;;) { args.push(expr()); if (at("op", ",")) { p++; continue; } break; }
    eat("op", ")");
    return args;
  }
  function stmt() {
    if (at("op", "{")) return block();
    if (at("kw", "量") || at("kw", "字") || at("kw", "占") || at("op", "分")) {
      const ty = type();
      const name = eat("id").v;
      if (at("op", "[")) {                     /* 类型化数组声明：量/分/字/占 名[长度]; */
        p++; const size = expr(); eat("op", "]"); eat("op", ";");
        return { t: "arrdecl", name, size, type: ty };
      }
      let init = null;
      if (at("op", "=") || at("op", "隹")) { p++; init = expr(); }
      eat("op", ";");
      return { t: "decl", name, init, type: ty };
    }
    if (at("kw", "恒")) {
      p++; const name = eat("id").v;
      if (!(at("op", "隹") || at("op", "="))) fail("常量声明需要 隹 初始值");
      p++; const init = expr(); eat("op", ";");
      return { t: "constdecl", name, init };
    }
    if (at("kw", "言") || at("kw", "卜")) {
      const kind = toks[p++].v;
      const args = [];
      for (;;) { args.push(expr()); if (at("op", ",")) { p++; continue; } break; }
      eat("op", ";");
      return { t: kind === "言" ? "print" : "assert", args };
    }
    if (at("kw", "若")) {
      p++; eat("op", "("); const c = expr(); eat("op", ")");
      const then = block();
      let els = null;
      if (at("kw", "弗")) { p++; els = block(); }
      return { t: "if", c, then, els };
    }
    if (at("kw", "復")) { p++; eat("op", "("); const c = expr(); eat("op", ")"); return { t: "while", c, body: block() }; }
    if (at("kw", "從")) {
      p++; eat("op", "(");
      let init = null;
      if (!at("op", ";")) {
        if (at("kw", "量") || at("kw", "字") || at("kw", "占") || at("op", "分")) {
          const ty = type(); const n = eat("id").v;
          if (at("op", "[")) { fail("從 的初始化里不支持数组声明"); }
          let e = null; if (at("op", "=") || at("op", "隹")) { p++; e = expr(); }
          init = { t: "decl", name: n, init: e, type: ty };
        } else init = { t: "exprst", e: expr() };
      }
      eat("op", ";");
      const cond = at("op", ";") ? null : expr();
      eat("op", ";");
      let step = null;
      if (!at("op", ")")) {
        if (at("id") && toks[p + 1] && toks[p + 1].t === "op" && ["=", "隹", "+=", "-="].includes(toks[p + 1].v)) {
          const nm = toks[p++].v; let op = toks[p++].v; if (op === "隹") op = "="; const val = expr();
          step = { t: "assignstep", name: nm, op, value: val };
        } else step = expr();
      }
      eat("op", ")");
      return { t: "for", init, cond, step, body: block() };
    }
    if (at("kw", "歸")) {
      p++; const e = at("op", ";") ? null : expr(); eat("op", ";");
      return { t: "ret", e };
    }
    if (at("kw", "止")) {
      p++; eat("op", ";");
      return { t: "break" };
    }
    if (at("kw", "续")) {
      p++; eat("op", ";");
      return { t: "continue" };
    }
    if (at("id")) {
      const name = peek().v;
      /* 语句级调用：屏(); 听(); 用户函数(); */
      if (toks[p + 1] && toks[p + 1].t === "op" && toks[p + 1].v === "(") {
        p++;
        const args = paramsOf();
        eat("op", ";");
        return { t: "exprst", e: { t: "call", callee: { t: "id", v: name }, args } };
      }
      /* 赋值：名 = … ; 或 名[下标] = … ; */
      p++;
      let target = { t: "id", v: name };
      if (at("op", "[")) { p++; const idx = expr(); eat("op", "]"); target = { t: "index", name, idx }; }
      if (at("op", "=") || at("op", "隹") || at("op", "+=") || at("op", "-=")) {
        const raw = toks[p++].v;
        const op = raw === "隹" ? "=" : raw;
        const v = expr(); eat("op", ";");
        return { t: "assign", target, op, value: v };
      }
      fail(`语句错误：${name} 后应为 = += -= 或 (…)`);
    }
    fail("无法解析的语句");
  }
  function expr() { return binary(0); }
  const LV = [["||"], ["&&"], ["隹", "不", "==", "!="], ["<", ">", "<=", ">="], ["益", "+", "去", "-"], ["乘", "*", "分", "/", "%"]];
  function binary(lv) {
    if (lv >= LV.length) return unary();
    let a = binary(lv + 1);
    while (peek() && peek().t === "op" && LV[lv].includes(peek().v)) {
      let op = toks[p++].v;
      if (lv === 2 && op === "不") {
        if (!(peek() && peek().t === "op" && peek().v === "隹")) throw new CompileError("「不」后面应为「隹」（不等写作 不隹）", peek().line, peek().col);
        p++; op = "!=";
      } else if (op === "隹") op = "==";
      else if (op === "益") op = "+";
      else if (op === "去") op = "-";
      else if (op === "乘") op = "*";
      else if (op === "分") op = "/";
      a = { t: "bin", op, a, b: binary(lv + 1) };
    }
    return a;
  }
  function unary() {
    if (at("op", "!")) { p++; return { t: "un", op: "!", a: unary() }; }
    if (at("op", "-")) { p++; return { t: "un", op: "-", a: unary() }; }
    if (at("op", "(")) { p++; const e = expr(); eat("op", ")"); return e; }
    return postfix();
  }
  function postfix() {
    let a = primary();
    for (;;) {
      if (at("op", "(")) {
        p++;
        const args = [];
        if (!at("op", ")")) for (;;) { args.push(expr()); if (at("op", ",")) { p++; continue; } break; }
        eat("op", ")");
        a = { t: "call", callee: a, args };
      } else if (at("op", "[")) {
        if (a.t !== "id") fail("只有数组名可以下标");
        p++; const idx = expr(); eat("op", "]");
        a = { t: "index", name: a.v, idx };
      } else break;
    }
    return a;
  }
  function primary() {
    if (at("num")) { const tok = toks[p++]; return { t: "num", v: tok.v, f: !!tok.f }; }
    if (at("str")) { const v = toks[p++].v; return { t: "str", v }; }
    if (at("bool")) { const v = toks[p++].v; return { t: "bool", v }; }
    if (at("id")) { const v = toks[p++].v; return { t: "id", v }; }
    fail("表达式错误");
  }
  function top() {
    const ty = type();
    const name = eat("id").v;
    eat("op", "(");
    const params = [];
    if (!at("op", ")")) {
      for (;;) {
        const pt = type(); const pn = eat("id").v;
        let isArr = false;
        if (at("op", "[")) { p++; eat("op", "]"); isArr = true; }
        params.push({ type: pt, name: pn, arr: isArr });
        if (at("op", ",")) { p++; continue; }
        break;
      }
    }
    eat("op", ")");
    return { t: "func", ret: ty, name, params, body: block() };
  }
  const funcs = [];
  const imports = [];
  while (!at("eof")) {
    if (at("kw", "引")) { p++; const name = eat("id").v; eat("op", ";"); imports.push(name); continue; }
    funcs.push(top());
  }
  return { t: "program", funcs, imports };
}

/* ---------------------------- 语义检查 ---------------------------- */
const BUILTINS = {
  "屏": { argc: 0, ret: "void", args: [] },
  "书": { argc: 1, ret: "void", args: ["any"] },
  "听": { argc: 0, ret: "int", args: [] },
  "聽": { argc: 0, ret: "int", args: [] },
  "歇": { argc: 1, ret: "void", args: ["int"] },
  "文長": { argc: 1, ret: "int", args: ["string"] },
  "取文": { argc: 3, ret: "string", args: ["string", "int", "int"] },
  "解文": { argc: 1, ret: "int", args: ["string"] },
  "解浮": { argc: 1, ret: "float", args: ["string"] },
};

function check(ast) {
  const funcs = new Map();
  for (const f of ast.funcs) {
    if (funcs.has(f.name)) throw new Error("语义：函数重复定义「" + f.name + "」");
    if (BUILTINS[f.name]) throw new Error("语义：函数名与内建冲突「" + f.name + "」");
    funcs.set(f.name, f);
  }
  if (!funcs.has("貞")) throw new Error("语义：缺少入口函数「貞」（相当于 main）");
  let decls = 0;
  let loopDepth = 0;
  const isNum = (ty) => ty === "int" || ty === "float";
  const assignable = (dst, src) => dst === src || (dst === "float" && src === "int");
  const fail = (msg) => { throw new Error("语义：" + msg); };

  function typeOf(e, scope) {
    if (!e) return "void";
    switch (e.t) {
      case "num": return e.f ? "float" : "int";
      case "bool": return "bool";
      case "str": return "string";
      case "id": {
        const s = scope.get(e.v);
        if (!s) fail("未声明的变量「" + e.v + "」");
        if (s.kind === "arr") return "arr:" + s.elem;
        return s.type;
      }
      case "index": {
        const s = scope.get(e.name);
        if (!s) fail("未声明的数组「" + e.name + "」");
        if (s.kind !== "arr") fail("「" + e.name + "」不是数组");
        if (typeOf(e.idx, scope) !== "int") fail("数组下标必须是 量（int）");
        return s.elem;
      }
      case "un": {
        const ty = typeOf(e.a, scope);
        if (e.op === "!") { if (ty !== "bool") fail("! 需要 占（bool）"); return "bool"; }
        if (!isNum(ty)) fail("负号需要数值，得到 " + ty);
        return ty;
      }
      case "bin": {
        const a = typeOf(e.a, scope), b = typeOf(e.b, scope);
        const op = e.op;
        if (op === "+") {
          if (a === "string" || b === "string") {
            if (a !== "string" || b !== "string") fail("字符串拼接需要两边都是 字（string）");
            return "string";
          }
          if (!isNum(a) || !isNum(b)) fail("益 需要数值或字符串");
          return (a === "float" || b === "float") ? "float" : "int";
        }
        if (op === "-" || op === "*" || op === "/") {
          if (!isNum(a) || !isNum(b)) fail(op + " 需要数值");
          return (a === "float" || b === "float") ? "float" : "int";
        }
        if (op === "%") {
          if (a !== "int" || b !== "int") fail("% 需要 量（int）");
          return "int";
        }
        if (op === "==" || op === "!=") {
          const ok = a === b || (isNum(a) && isNum(b));
          if (!ok) fail("比较类型不一致：" + a + " 与 " + b);
          return "bool";
        }
        if (op === "<" || op === ">" || op === "<=" || op === ">=") {
          if (!isNum(a) || !isNum(b)) fail("大小比较需要数值");
          return "bool";
        }
        if (op === "&&" || op === "||") {
          if (a !== "bool" || b !== "bool") fail("且/或 需要 占（bool）");
          return "bool";
        }
        fail("未知运算符 " + op);
      }
      case "call": {
        if (e.callee.t !== "id") fail("只能调用具名函数");
        const name = e.callee.v;
        const f = funcs.get(name);
        const b = BUILTINS[name];
        if (f) {
          if (e.args.length !== f.params.length) fail("函数「" + name + "」需要 " + f.params.length + " 个参数，给了 " + e.args.length + " 个");
          for (let i = 0; i < e.args.length; i++) {
            const actual = typeOf(e.args[i], scope);
            const decl = f.params[i];
            if (decl.arr) {
              if (actual !== "arr:" + decl.type) fail("函数「" + name + "」第 " + (i + 1) + " 个参数需要 " + decl.type + " 数组，得到 " + actual);
            } else if (actual.indexOf("arr:") === 0) {
              fail("函数「" + name + "」第 " + (i + 1) + " 个参数需要 " + decl.type + "，得到数组");
            } else if (!assignable(decl.type, actual)) {
              fail("函数「" + name + "」第 " + (i + 1) + " 个参数需要 " + decl.type + "，得到 " + actual);
            }
          }
          return f.ret;
        }
        if (b) {
          if (e.args.length !== b.argc) fail("内建「" + name + "」需要 " + b.argc + " 个参数，给了 " + e.args.length + " 个");
          for (let i = 0; i < e.args.length; i++) {
            const actual = typeOf(e.args[i], scope);
            if (actual.indexOf("arr:") === 0) fail("内建「" + name + "」不接受数组参数");
            const spec = b.args[i] || "any";
            if (spec !== "any" && !assignable(spec, actual)) fail("内建「" + name + "」第 " + (i + 1) + " 个参数需要 " + spec + "，得到 " + actual);
          }
          return b.ret;
        }
        fail("未定义的函数「" + name + "」");
      }
      default: fail("未知表达式 " + e.t);
    }
  }

  function condType(e, scope, where) {
    const ty = typeOf(e, scope);
    if (ty !== "bool") fail(where + " 需要 占（bool），得到 " + ty);
  }

  function walkScope(body, scope, fn) {
    for (const s of body) {
      if (s.t === "decl") {
        if (scope.has(s.name)) fail("变量重复声明「" + s.name + "」");
        if (s.init) {
          const ty = typeOf(s.init, scope);
          if (!assignable(s.type, ty)) fail("变量「" + s.name + "」类型 " + s.type + " 不能接收 " + ty);
        }
        scope.set(s.name, { type: s.type, kind: "var" });
        decls++;
      } else if (s.t === "constdecl") {
        if (scope.has(s.name)) fail("名字重复声明「" + s.name + "」");
        const ty = typeOf(s.init, scope);
        if (ty.indexOf("arr:") === 0) fail("常量不能是数组");
        scope.set(s.name, { type: ty, kind: "const" });
        decls++;
      } else if (s.t === "arrdecl") {
        if (scope.has(s.name)) fail("变量重复声明「" + s.name + "」");
        if (typeOf(s.size, scope) !== "int") fail("数组长度必须是 量（int）");
        scope.set(s.name, { type: "arr", kind: "arr", elem: s.type });
        decls++;
      } else if (s.t === "assign") {
        const tgt = s.target;
        if (s.op !== "=") fail("暂不支持复合赋值（用 名 = 名 益 值）");
        if (tgt.t === "id") {
          const e = scope.get(tgt.v);
          if (!e) fail("未声明的变量「" + tgt.v + "」");
          if (e.kind === "arr") fail("不能整体赋值数组「" + tgt.v + "」");
          if (e.kind === "const") fail("常量「" + tgt.v + "」不可赋值");
          const ty = typeOf(s.value, scope);
          if (!assignable(e.type, ty)) fail("变量「" + tgt.v + "」类型 " + e.type + " 不能接收 " + ty);
        } else {
          const e = scope.get(tgt.name);
          if (!e) fail("未声明的数组「" + tgt.name + "」");
          if (e.kind !== "arr") fail("「" + tgt.name + "」不是数组");
          if (typeOf(tgt.idx, scope) !== "int") fail("数组下标必须是 量（int）");
          const ty = typeOf(s.value, scope);
          if (!assignable(e.elem, ty)) fail("数组「" + tgt.name + "」元素类型 " + e.elem + " 不能接收 " + ty);
        }
      } else if (s.t === "print") {
        for (const a of s.args) {
          const ty = typeOf(a, scope);
          if (ty === "void") fail("不能打印 無（void）");
          if (ty.indexOf("arr:") === 0) fail("不能直接打印数组");
        }
      } else if (s.t === "assert") {
        for (const a of s.args) {
          const ty = typeOf(a, scope);
          if (ty.indexOf("arr:") === 0) fail("卜 不能接数组");
          if (ty !== "bool" && ty !== "int") fail("卜 需要 占（bool）或 量（int）");
        }
      } else if (s.t === "exprst") {
        typeOf(s.e, scope);
      } else if (s.t === "if") {
        condType(s.c, scope, "若");
        walkScope(s.then.body, new Map(scope), fn);
        if (s.els) walkScope(s.els.body, new Map(scope), fn);
      } else if (s.t === "while") {
        condType(s.c, scope, "復");
        loopDepth++;
        walkScope(s.body.body, new Map(scope), fn);
        loopDepth--;
      } else if (s.t === "for") {
        const inner = new Map(scope);
        if (s.init) {
          if (s.init.t === "decl") {
            if (inner.has(s.init.name)) fail("变量重复声明「" + s.init.name + "」");
            if (s.init.init) {
              const ty = typeOf(s.init.init, inner);
              if (!assignable(s.init.type, ty)) fail("变量「" + s.init.name + "」类型 " + s.init.type + " 不能接收 " + ty);
            }
            inner.set(s.init.name, { type: s.init.type, kind: "var" });
          } else typeOf(s.init.e, inner);
        }
        if (s.cond) condType(s.cond, inner, "從");
        if (s.step) {
          if (s.step.t === "assignstep") {
            const e = inner.get(s.step.name);
            if (!e) fail("未声明的变量「" + s.step.name + "」");
            if (e.kind === "arr") fail("不能整体赋值数组「" + s.step.name + "」");
            if (e.kind === "const") fail("常量「" + s.step.name + "」不可赋值");
            if (!isNum(e.type)) fail("步进变量需要数值");
            const ty = typeOf(s.step.value, new Map(inner));
            if (!assignable(e.type, ty)) fail("变量「" + s.step.name + "」类型 " + e.type + " 不能接收 " + ty);
          } else typeOf(s.step, new Map(inner));
        }
        loopDepth++;
        walkScope(s.body.body, inner, fn);
        loopDepth--;
      } else if (s.t === "break") {
        if (loopDepth === 0) fail("止（break）只能写在循环里");
      } else if (s.t === "continue") {
        if (loopDepth === 0) fail("续（continue）只能写在循环里");
      } else if (s.t === "ret") {
        if (fn.ret === "void") {
          if (s.e) fail("无返回值函数「" + fn.name + "」不能 歸 值");
        } else if (!s.e) {
          fail("函数「" + fn.name + "」需要返回 " + fn.ret);
        } else {
          const ty = typeOf(s.e, scope);
          if (ty.indexOf("arr:") === 0) fail("函数不能返回数组");
          if (!assignable(fn.ret, ty)) fail("函数「" + fn.name + "」返回类型 " + fn.ret + "，得到 " + ty);
        }
      }
    }
  }

  for (const f of ast.funcs) {
    const scope = new Map();
    for (const x of f.params) {
      if (x.type === "void") fail("参数不能是 無（void）");
      if (scope.has(x.name)) fail("参数重名「" + x.name + "」");
      scope.set(x.name, x.arr ? { type: "arr", kind: "arr", elem: x.type } : { type: x.type, kind: "var" });
    }
    walkScope(f.body.body, scope, f);
  }
  return { funcs, decls };
}

/* ---------------------------- 字节码 ---------------------------- */
const OP = {
  PUSH: 0x01, PUSHS: 0x02, LOAD: 0x03, STORE: 0x04, POP: 0x05,
  NEWARR: 0x06, LOADIDX: 0x07, STOREIDX: 0x08, DEFAULT: 0x09, PUSHF: 0x0a, PUSHBOOL: 0x0b,
  ADD: 0x10, SUB: 0x11, MUL: 0x12, DIV: 0x13, MOD: 0x14, NEG: 0x15, NOT: 0x16,
  EQ: 0x20, NE: 0x21, LT: 0x22, LE: 0x23, GT: 0x24, GE: 0x25, AND: 0x26, OR: 0x27,
  JMP: 0x30, JZ: 0x31, JNZ: 0x32,
  CALL: 0x40, RET: 0x50, PRINT: 0x60, ASSERT: 0x61, HALT: 0x7f,
};
const OPNAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

function compile(ast, funcs) {
  const strings = [];
  const loopStack = [];
  const strIdx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const chunks = [];
  let slotCount = 0;

  const emit = (ch, op, arg) => ch.code.push({ op, arg });

  function expr(ch, e, scope) {
    if (!e) return;
    if (e.t === "num") return emit(ch, e.f ? OP.PUSHF : OP.PUSH, e.v);
    if (e.t === "bool") return emit(ch, OP.PUSHBOOL, e.v ? 1 : 0);
    if (e.t === "str") return emit(ch, OP.PUSHS, strIdx(e.v));
    if (e.t === "id") {
      const s = scope.get(e.v);
      if (s === undefined) throw new Error("代码生成：找不到变量槽「" + e.v + "」");
      return emit(ch, OP.LOAD, s);
    }
    if (e.t === "index") {
      const s = scope.get(e.name);
      if (s === undefined) throw new Error("代码生成：找不到数组槽「" + e.name + "」");
      emit(ch, OP.LOAD, s);
      expr(ch, e.idx, scope);
      return emit(ch, OP.LOADIDX, null);
    }
    if (e.t === "un") { expr(ch, e.a, scope); emit(ch, e.op === "!" ? OP.NOT : OP.NEG, null); return; }
    if (e.t === "bin") {
      expr(ch, e.a, scope); expr(ch, e.b, scope);
      const m = { "+": OP.ADD, "-": OP.SUB, "*": OP.MUL, "/": OP.DIV, "%": OP.MOD, "==": OP.EQ, "!=": OP.NE, "<": OP.LT, "<=": OP.LE, ">": OP.GT, ">=": OP.GE, "&&": OP.AND, "||": OP.OR };
      if (!m[e.op]) throw new Error("代码生成：不支持的运算符 " + e.op);
      emit(ch, m[e.op], null); return;
    }
    if (e.t === "call") {
      for (const a of e.args) expr(ch, a, scope);
      return emit(ch, OP.CALL, { fn: e.callee.v, argc: e.args.length });
    }
    throw new Error("代码生成：未知表达式 " + e.t);
  }

  function stmts(ch, body, scope) {
    for (const s of body) {
      if (s.t === "decl" || s.t === "constdecl") {
        const slot = slotCount++;
        scope.set(s.name, slot);
        if (s.init) { expr(ch, s.init, scope); emit(ch, OP.STORE, slot); }
        else { emit(ch, OP.DEFAULT, { int: 0, float: 1, string: 2, bool: 3 }[s.type || "int"]); emit(ch, OP.STORE, slot); }
      } else if (s.t === "arrdecl") {
        const slot = slotCount++;
        scope.set(s.name, slot);
        expr(ch, s.size, scope);
        emit(ch, OP.NEWARR, { int: 0, float: 1, string: 2, bool: 3 }[s.type || "int"]);
        emit(ch, OP.STORE, slot);
      } else if (s.t === "assign") {
        const t = s.target;
        if (t.t === "id") {
          const slot = scope.get(t.v);
          if (slot === undefined) throw new Error("代码生成：找不到变量槽「" + t.v + "」");
          if (s.op === "=") expr(ch, s.value, scope);
          else { emit(ch, OP.LOAD, slot); expr(ch, s.value, scope); emit(ch, s.op === "+=" ? OP.ADD : OP.SUB, null); }
          emit(ch, OP.STORE, slot);
        } else {
          const slot = scope.get(t.name);
          if (slot === undefined) throw new Error("代码生成：找不到数组槽「" + t.name + "」");
          emit(ch, OP.LOAD, slot);
          expr(ch, t.idx, scope);
          expr(ch, s.value, scope);
          emit(ch, OP.STOREIDX, null);
        }
      } else if (s.t === "print" || s.t === "assert") {
        for (const a of s.args) expr(ch, a, scope);
        emit(ch, s.t === "print" ? OP.PRINT : OP.ASSERT, s.args.length);
      } else if (s.t === "exprst") {
        expr(ch, s.e, scope);
        emit(ch, OP.POP, null);
      } else if (s.t === "if") {
        expr(ch, s.c, scope);
        const jz = { op: OP.JZ, arg: null }; ch.code.push(jz);
        stmts(ch, s.then.body, new Map(scope));
        if (s.els) {
          const jmp = { op: OP.JMP, arg: null }; ch.code.push(jmp);
          jz.arg = ch.code.length;
          stmts(ch, s.els.body, new Map(scope));
          jmp.arg = ch.code.length;
        } else jz.arg = ch.code.length;
      } else if (s.t === "while") {
        const top = ch.code.length;
        expr(ch, s.c, scope);
        const jz = { op: OP.JZ, arg: null }; ch.code.push(jz);
        const rec = { breaks: [], continues: [] };
        loopStack.push(rec);
        stmts(ch, s.body.body, new Map(scope));
        loopStack.pop();
        emit(ch, OP.JMP, top);
        jz.arg = ch.code.length;
        for (const b of rec.breaks) b.arg = ch.code.length;
        for (const c of rec.continues) c.arg = top;
      } else if (s.t === "for") {
        const inner = new Map(scope);
        if (s.init) {
          if (s.init.t === "decl") {
            const slot = slotCount++;
            inner.set(s.init.name, slot);
            if (s.init.init) { expr(ch, s.init.init, inner); emit(ch, OP.STORE, slot); }
            else { emit(ch, OP.PUSH, 0); emit(ch, OP.STORE, slot); }
          } else { expr(ch, s.init.e, inner); emit(ch, OP.POP, null); }
        }
        const top = ch.code.length;
        let jz = null;
        if (s.cond) { expr(ch, s.cond, inner); jz = { op: OP.JZ, arg: null }; ch.code.push(jz); }
        const rec = { breaks: [], continues: [] };
        loopStack.push(rec);
        stmts(ch, s.body.body, new Map(inner));
        loopStack.pop();
        const stepStart = ch.code.length;
        if (s.step) {
          if (s.step.t === "assignstep") {
            const sl = inner.get(s.step.name);
            if (sl === undefined) throw new Error("代码生成：找不到变量槽「" + s.step.name + "」");
            if (s.step.op === "=") expr(ch, s.step.value, inner);
            else { emit(ch, OP.LOAD, sl); expr(ch, s.step.value, inner); emit(ch, s.step.op === "+=" ? OP.ADD : OP.SUB, null); }
            emit(ch, OP.STORE, sl);
          } else { expr(ch, s.step, inner); emit(ch, OP.POP, null); }
        }
        emit(ch, OP.JMP, top);
        if (jz) jz.arg = ch.code.length;
        for (const b of rec.breaks) b.arg = ch.code.length;
        for (const c of rec.continues) c.arg = stepStart;
      } else if (s.t === "break") {
        if (!loopStack.length) throw new Error("代码生成：止 不在循环里");
        const j = { op: OP.JMP, arg: null };
        ch.code.push(j);
        loopStack[loopStack.length - 1].breaks.push(j);
      } else if (s.t === "continue") {
        if (!loopStack.length) throw new Error("代码生成：续 不在循环里");
        const j = { op: OP.JMP, arg: null };
        ch.code.push(j);
        loopStack[loopStack.length - 1].continues.push(j);
      } else if (s.t === "ret") {
        if (s.e) expr(ch, s.e, scope);
        else emit(ch, OP.PUSH, 0);
        emit(ch, OP.RET, null);
      } else if (s.t === "block") {
        stmts(ch, s.body, new Map(scope));
      }
    }
  }

  for (const f of ast.funcs) {
    const ch = { name: f.name, code: [], params: f.params.length, paramBase: slotCount };
    const scope = new Map();
    f.params.forEach((x) => scope.set(x.name, slotCount++));
    stmts(ch, f.body.body, scope);
    emit(ch, OP.HALT, null);
    chunks.push(ch);
  }
  for (const c of chunks) c.nlocals = slotCount;
  return { strings, chunks, slotCount };
}

/* ---------------------------- 键盘输入（异步） ---------------------------- */
function makeInput(initial) {
  const bytes = [];
  const preset = initial !== undefined && initial !== null;
  if (preset) for (const b of Buffer.from(String(initial), "utf8")) bytes.push(b);
  let started = false, eof = preset, raw = false;
  const waiters = [];
  function decode() {
    if (!bytes.length) return eof ? 0 : null;
    const c = bytes[0];
    if (c === 0x1b) {
      if (bytes.length >= 3) {
        const b1 = bytes[1], b2 = bytes[2];
        bytes.splice(0, 3);
        if (b1 === 0x5b || b1 === 0x4f) {
          if (b2 === 0x41) return 1;
          if (b2 === 0x42) return 2;
          if (b2 === 0x44) return 3;
          if (b2 === 0x43) return 4;
        }
        return 9;   /* 未识别的转义序列：当作无操作 */
      }
      if (eof) { bytes.shift(); return 0; }
      return null;
    }
    bytes.shift();
    if (c === 0x71 || c === 0x51) return 0;   /* q 退出 */
    if (c === 0x77 || c === 0x57) return 1;   /* w 上 */
    if (c === 0x73 || c === 0x53) return 2;   /* s 下 */
    if (c === 0x61 || c === 0x41) return 3;   /* a 左 */
    if (c === 0x64 || c === 0x44) return 4;   /* d 右 */
    return 9;   /* 其它键：无操作 */
  }
  function pump() {
    while (waiters.length) {
      const k = decode();
      if (k === null) break;
      waiters.shift()(k);
    }
  }
  function start() {
    if (started) return;
    started = true;
    try { if (process.stdin.isTTY) { process.stdin.setRawMode(true); raw = true; } } catch (e) {}
    try { process.stdin.resume(); } catch (e) {}
    process.stdin.on("data", (b) => { for (const x of b) bytes.push(x); pump(); });
    process.stdin.on("end", () => { eof = true; pump(); });
    process.stdin.on("error", () => { eof = true; pump(); });
  }
  return {
    async key() {
      if (preset) { const k = decode(); return k === null ? 0 : k; }
      start();
      const k = decode();
      if (k !== null) return k;
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      try { if (raw) process.stdin.setRawMode(false); } catch (e) {}
      try { process.stdin.pause(); } catch (e) {}
    },
  };
}

/* ---------------------------- 虚拟机（异步） ---------------------------- */
async function vm(prog, opts = {}) {
  const labels = Object.fromEntries(prog.chunks.map((c, i) => [c.name, i]));
  const out = [];
  const stack = [];
  const input = makeInput(opts.input);
  const silent = !!opts.silent;
  const MAX_STEPS = 5_000_000;
  const MAX_DEPTH = 400;
  let steps = 0, depth = 0;

  const isF = (v) => v !== null && typeof v === "object" && v.__kind === "float";
  const mkF = (n) => ({ __kind: "float", v: n });
  const fval = (v) => (isF(v) ? v.v : v);
  const fmtVal = (v) => {
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "吉" : "非";
    if (isF(v)) {
      const n = v.v;
      let s2 = n.toFixed(6).replace(/0+$/, "").replace(/\\.$/, "");
      return s2.indexOf(".") >= 0 ? s2 : s2 + ".0";
    }
    return String(v);
  };
  const printv = fmtVal;
  const truthy = (v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.length > 0;
    if (isF(v)) return v.v !== 0;
    if (typeof v === "number") return v !== 0;
    throw new Error("运行：无法判断真假");
  };
  const writeOut = (s) => { try { if (!silent) process.stdout.write(s); } catch (e) {} };

  function num(v, what) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("运行：" + what + " 需要整数，得到 " + printv(v));
    if (!Number.isInteger(v)) throw new Error("运行：" + what + " 需要整数，得到 " + v);
    return Math.trunc(v);
  }

  async function runFn(chunk, args) {
    if (++depth > MAX_DEPTH) throw new Error("运行：调用层级过深（可能递归无终止）");
    const frame = { locals: new Array(chunk.nlocals).fill(0) };
    const pb = chunk.paramBase || 0;
    for (let i = 0; i < args.length && i < chunk.params; i++) frame.locals[pb + i] = args[i];
    let pc = 0;
    try {
      for (;;) {
        if (++steps > MAX_STEPS) throw new Error("运行：指令数超限（可能死循环）");
        const ins = chunk.code[pc];
        if (!ins) throw new Error("运行：越过代码末尾");
        switch (ins.op) {
          case OP.PUSH: stack.push(ins.arg); pc++; break;
          case OP.PUSHS: stack.push(prog.strings[ins.arg]); pc++; break;
          case OP.PUSHF: stack.push(mkF(ins.arg)); pc++; break;
          case OP.PUSHBOOL: stack.push(!!ins.arg); pc++; break;
          case OP.LOAD: stack.push(frame.locals[ins.arg] ?? 0); pc++; break;
          case OP.STORE: frame.locals[ins.arg] = stack.pop(); pc++; break;
          case OP.POP: stack.pop(); pc++; break;
          case OP.NEWARR: {
            const n = num(stack.pop(), "数组长度");
            if (n < 0 || n > 1_000_000) throw new Error("运行：数组长度非法（" + n + "）");
            const ty = ins.arg | 0;
            const fill = ty === 1 ? mkF(0) : ty === 2 ? "" : ty === 3 ? false : 0;
            stack.push(new Array(n).fill(fill));
            pc++; break;
          }
          case OP.DEFAULT: {
            const ty = ins.arg | 0;
            stack.push(ty === 1 ? mkF(0) : ty === 2 ? "" : ty === 3 ? false : 0);
            pc++; break;
          }
          case OP.LOADIDX: {
            const i = num(stack.pop(), "下标");
            const a = stack.pop();
            if (!Array.isArray(a)) throw new Error("运行：对非数组取下标");
            if (i < 0 || i >= a.length) throw new Error("运行：数组越界（" + i + " 不在 0.." + (a.length - 1) + "）");
            stack.push(a[i]);
            pc++; break;
          }
          case OP.STOREIDX: {
            const v = stack.pop();
            const i = num(stack.pop(), "下标");
            const a = stack.pop();
            if (!Array.isArray(a)) throw new Error("运行：对非数组写下标");
            if (i < 0 || i >= a.length) throw new Error("运行：数组越界（" + i + " 不在 0.." + (a.length - 1) + "）");
            a[i] = v;
            pc++; break;
          }
          case OP.ADD: {
            const b = stack.pop(), a = stack.pop();
            if (typeof a === "string" || typeof b === "string") {
              if (typeof a !== "string" || typeof b !== "string") throw new Error("运行：字符串拼接两边都要是 字");
              stack.push(a + b);
            } else if (isF(a) || isF(b)) stack.push(mkF(fval(a) + fval(b)));
            else stack.push((a + b) | 0);
            pc++; break;
          }
          case OP.SUB: {
            const b = stack.pop(), a = stack.pop();
            if (isF(a) || isF(b)) stack.push(mkF(fval(a) - fval(b)));
            else stack.push((a - b) | 0);
            pc++; break;
          }
          case OP.MUL: {
            const b = stack.pop(), a = stack.pop();
            if (isF(a) || isF(b)) stack.push(mkF(fval(a) * fval(b)));
            else stack.push(Math.imul ? Math.imul(a, b) : a * b);
            pc++; break;
          }
          case OP.DIV: {
            const b = stack.pop(), a = stack.pop();
            if (isF(a) || isF(b)) { const d = fval(b); if (d === 0) throw new Error("运行：除以零"); stack.push(mkF(fval(a) / d)); }
            else { if (b === 0) throw new Error("运行：除以零"); stack.push(Math.trunc(a / b)); }
            pc++; break;
          }
          case OP.MOD: { const b = stack.pop(), a = stack.pop(); if (b === 0) throw new Error("运行：除零取余"); stack.push(a % b); pc++; break; }
          case OP.NEG: { const a = stack.pop(); stack.push(isF(a) ? mkF(-a.v) : -a); pc++; break; }
          case OP.NOT: { const a = stack.pop(); stack.push(!truthy(a)); pc++; break; }
          case OP.EQ: { const b = stack.pop(), a = stack.pop(); stack.push(eqVal(a, b)); pc++; break; }
          case OP.NE: { const b = stack.pop(), a = stack.pop(); stack.push(!eqVal(a, b)); pc++; break; }
          case OP.LT: { const b = stack.pop(), a = stack.pop(); stack.push(fval(a) < fval(b)); pc++; break; }
          case OP.LE: { const b = stack.pop(), a = stack.pop(); stack.push(fval(a) <= fval(b)); pc++; break; }
          case OP.GT: { const b = stack.pop(), a = stack.pop(); stack.push(fval(a) > fval(b)); pc++; break; }
          case OP.GE: { const b = stack.pop(), a = stack.pop(); stack.push(fval(a) >= fval(b)); pc++; break; }
          case OP.AND: { const b = stack.pop(), a = stack.pop(); stack.push(truthy(a) && truthy(b)); pc++; break; }
          case OP.OR: { const b = stack.pop(), a = stack.pop(); stack.push(truthy(a) || truthy(b)); pc++; break; }
          case OP.JMP: pc = ins.arg; break;
          case OP.JZ: pc = truthy(stack.pop()) ? pc + 1 : ins.arg; break;
          case OP.JNZ: pc = truthy(stack.pop()) ? ins.arg : pc + 1; break;
          case OP.CALL: {
            const args2 = [];
            for (let i = 0; i < ins.arg.argc; i++) args2.unshift(stack.pop());
            const idx = labels[ins.arg.fn];
            if (idx !== undefined) {
              const v = await runFn(prog.chunks[idx], args2);
              if (v !== undefined) stack.push(v);
            } else {
              const v = await callBuiltin(ins.arg.fn, args2);
              if (v !== undefined) stack.push(v);
            }
            pc++; break;
          }
          case OP.RET: return stack.pop();
          case OP.PRINT: {
            const n = ins.arg, items = [];
            for (let i = 0; i < n; i++) items.unshift(stack.pop());
            const line = items.map(printv).join(" ");
            out.push(line);
            writeOut(line + "\n");
            pc++; break;
          }
          case OP.ASSERT: {
            const v = stack.pop();
            const line = truthy(v) ? "合" : "不合";
            out.push(line);
            writeOut(line + "\n");
            pc++; break;
          }
          case OP.HALT: return stack.pop();
          default: throw new Error("运行：未知指令 0x" + ins.op.toString(16));
        }
      }
    } finally {
      depth--;
    }
  }

  function eqVal(a, b) {
    if (typeof a === "string" || typeof b === "string") return a === b;
    if (typeof a === "boolean" || typeof b === "boolean") return a === b;
    return fval(a) === fval(b);
  }

  async function callBuiltin(name, args) {
    if (name === "文長") {
      const s = args[0];
      if (typeof s !== "string") throw new Error("运行：文長 需要 字（string）");
      return Array.from(s).length;
    }
    if (name === "取文") {
      const s = args[0];
      if (typeof s !== "string") throw new Error("运行：取文 需要 字（string）");
      const start = num(args[1], "取文 起点");
      const cnt = num(args[2], "取文 长度");
      if (start < 0 || cnt < 0 || start > Array.from(s).length) throw new Error("运行：取文 范围非法");
      return Array.from(s).slice(start, start + cnt).join("");
    }
    if (name === "解文") {
      const s = String(args[0]).trim();
      if (/^[+-]?[0-9]+$/.test(s)) return parseInt(s, 10);
      let sign = 1, rest = s;
      if (rest[0] === "-" || rest[0] === "+") { sign = rest[0] === "-" ? -1 : 1; rest = rest.slice(1); }
      if (rest.length && [...rest].every((c) => NUMERAL_CHARS.includes(c))) return sign * parseNumeral(rest);
      throw new Error("运行：解文 无法解析「" + String(args[0]) + "」");
    }
    if (name === "解浮") {
      const raw = String(args[0]).trim();
      if (/^[+-]?[0-9]+(\.[0-9]+)?$/.test(raw)) return mkF(parseFloat(raw));
      let sign = 1, rest = raw;
      if (rest[0] === "-" || rest[0] === "+") { sign = rest[0] === "-" ? -1 : 1; rest = rest.slice(1); }
      const parts = rest.split("·");
      if (parts.length === 2 && parts[0].length && parts[1].length && [...(parts[0] + parts[1])].every((c) => NUMERAL_CHARS.includes(c))) {
        const ip = parseNumeral(parts[0]);
        let frac = 0;
        for (let k = 0; k < parts[1].length; k++) frac = frac * 10 + DIGIT[parts[1][k]];
        return mkF(sign * (ip + frac / Math.pow(10, parts[1].length)));
      }
      throw new Error("运行：解浮 无法解析「" + raw + "」");
    }
    if (name === "屏") {
      if (process.stdout.isTTY) {
        if (process.env.WT_SESSION) writeOut("\x1b[2J\x1b[H");
        else writeOut("\n".repeat(24));
      }
      return 0;
    }
    if (name === "书") {
      const v = args[0];
      if (typeof v === "string") writeOut(v);
      else if (isF(v) || typeof v === "boolean") writeOut(fmtVal(v));
      else {
        const cp = num(v, "书");
        if (cp < 0 || cp > 0x10ffff) throw new Error("运行：书 的字符码越界（" + cp + "）");
        writeOut(String.fromCodePoint(cp));
      }
      return 0;
    }
    if (name === "听" || name === "聽") return await input.key();
    if (name === "歇") {
      const ms = num(args[0], "歇");
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10000, ms))));
      return 0;
    }
    throw new Error("运行：未定义的内建「" + name + "」");
  }

  let exit = 0, error = null;
  try {
    exit = (await runFn(prog.chunks[labels["貞"]], [])) || 0;
  } catch (e) {
    error = e.message;
    exit = 1;
  } finally {
    input.close();
  }
  return { out, exit, error, steps };
}

/* ---------------------------- 字节码清单 ---------------------------- */
function listing(prog) {
  const lines = ["JCB1", `funcs ${prog.chunks.length}`, `strings ${prog.strings.length}`, `slots ${prog.slotCount}`];
  prog.strings.forEach((s, i) => lines.push(`str ${i} "${s}"`));
  for (const c of prog.chunks) {
    lines.push("", `code ${c.name} params=${c.params} locals=${c.nlocals}`);
    c.code.forEach((ins, i) => {
      let arg = "";
      if (ins.op === OP.PUSH) arg = String(ins.arg);
      else if (ins.op === OP.PUSHF) arg = String(ins.arg);
      else if (ins.op === OP.PUSHBOOL) arg = ins.arg ? "吉" : "非";
      else if (ins.op === OP.NEWARR || ins.op === OP.DEFAULT) arg = ["int", "float", "string", "bool"][ins.arg] || String(ins.arg);
      else if (ins.op === OP.PUSHS) arg = "#" + ins.arg;
      else if (ins.op === OP.LOAD || ins.op === OP.STORE) arg = "s" + ins.arg;
      else if (ins.op === OP.CALL) arg = ins.arg.fn + "/" + ins.arg.argc;
      else if (ins.op === OP.JMP || ins.op === OP.JZ || ins.op === OP.JNZ) arg = "@" + ins.arg;
      else if (ins.op === OP.PRINT || ins.op === OP.ASSERT) arg = String(ins.arg);
      lines.push(`  ${String(i).padStart(4, "0")}  ${(OPNAME[ins.op] || "?").padEnd(8)} ${arg}`);
    });
  }
  return lines.join("\n");
}

/* ---------------------------- 竖排对刻 ---------------------------- */
/* 甲骨习惯：字自上而下成列，列自右而左；对刻 = 成对的列（如 若/弗、正卜/反卜） */
function toVertical(src) {
  const lines = src.split(/\r?\n/).filter((l) => l.length > 0);
  const cols = lines.map((line) => {
    const out = [];
    for (const ch of line) out.push(ch === " " ? "\u00A0" : ch);
    return out.join("\n");
  });
  return cols.reverse().join("\n\n") + "\n";
}
function fromVertical(text) {
  const cols = text
    .split(/\n[ \t]*\n/)
    .map((c) => c.split(/\r?\n/).filter((l) => l.length > 0).join(""));
  const lines = cols.reverse().map((c) => c.split("\u00A0").join(" "));
  return lines.filter((l) => l.length > 0).join("\n") + "\n";
}
function isVerticalSource(src) {
  return /^\s*[：；]\s*竖/.test(src);
}
function sourceFromFile(file) {
  let raw = fs.readFileSync(file, "utf8");
  if (/\.jcpv$/i.test(file) || isVerticalSource(raw)) {
    raw = raw.replace(/^\s*[：；]\s*竖[^\n]*\n/, "");
    return fromVertical(raw);
  }
  return raw;
}

/* ---------------------------- 程序 → 甲骨 PNG ---------------------------- */
const SKILL_FONT = "C:\\Users\\wangy\\.dsh\\skills\\zhenren\\data\\fonts\\orac.woff2";
function getFontB64() {
  if (globalThis.__JCP_FONT_B64) return globalThis.__JCP_FONT_B64;
  const cands = [process.env.JCP_FONT, SKILL_FONT, path.join(HERE, "orac.woff2")];
  for (const f of cands) {
    try { if (f && fs.existsSync(f)) return fs.readFileSync(f).toString("base64"); } catch (e) {}
  }
  return null;
}
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
function findBrowser() {
  if (process.env.JCP_BROWSER && fs.existsSync(process.env.JCP_BROWSER)) return process.env.JCP_BROWSER;
  for (const p of EDGE_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}
const PNG_MARK = {
  "(": '<path d="M15 4c-6 4-6 12 0 16"/>', ")": '<path d="M9 4c6 4 6 12 0 16"/>',
  "{": '<path d="M15 4c-6 1-6 6-6 8s0 7 6 8"/>', "}": '<path d="M9 4c6 1 6 6 6 8s0 7-6 8"/>',
  "[": '<path d="M16 4h-7v16h7"/>', "]": '<path d="M8 4h7v16H8"/>',
  ";": '<path d="M12 6v7"/><circle cx="12" cy="17" r="1.4"/>',
  "=": '<path d="M5 9h14M5 14h14"/>', "!": '<path d="M12 4v10"/><circle cx="12" cy="18" r="1.4"/>',
  "<": '<path d="M17 6l-9 6 9 6"/>', ">": '<path d="M7 6l9 6-9 6"/>',
  "%": '<path d="M7 18L17 6"/><circle cx="8" cy="8" r="1.2"/><circle cx="16" cy="16" r="1.2"/>',
  "*": '<path d="M12 4v16M4.5 8l15 8M19.5 8l-15 8"/>', "+": '<path d="M12 4v16M4 12h16"/>',
  "-": '<path d="M5 12h14"/>', "/": '<path d="M7 19L17 5"/>',
  "0": '<circle cx="12" cy="12" r="6.2"/>',
  "续": '<path d="M5 16c4 0 7-2 9-5"/><path d="M12 8l3 3-4 1"/>',
  "·": '<circle cx="12" cy="13" r="1.8"/>',
};
const pngMark = (ch) => '<span class="mk"><svg viewBox="0 0 24 24">' + (PNG_MARK[ch] || '<path d="M6 12h12"/>') + "</svg></span>";

function pngColumns(src) {
  const lines = src.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("；"))
    .filter((l) => !/[「」█◆·]/.test(l))
    .filter((l) => !/[书屏歇]/.test(l))
    .filter((l) => [...l].every((ch) => !/[\u3400-\u9fff]/.test(ch) || OPWORD[ch] || KW[ch] || NUMERAL_CHARS.includes(ch) || FONT.has(ch)));
  return lines.join(" ");
}

async function generatePng(src, opts) {
  const fontB64 = getFontB64();
  if (!fontB64) throw new Error("找不到甲骨字体（可用 JCP_FONT 指定 orac.woff2 路径）");
  const browser = findBrowser();
  if (!browser) throw new Error("找不到 Edge/Chrome（可用 JCP_BROWSER 指定浏览器路径）");
  const titleChars = (opts.title || "龜卜龜食").split("").filter((c) => FONT.has(c)).slice(0, 6).join("") || "龜卜";
  const text = pngColumns(src);
  if (!text.trim()) throw new Error("程序里没有可用的甲骨字形（可能全是注释或字符串）");

  /* 自适应：字少则列少、字大、骨窄 */
  const n = text.length;
  const PER = Math.max(8, Math.min(22, Math.ceil(n / 14)));
  const chunks = [];
  for (let i = 0; i < n && chunks.length < 26; i += PER) chunks.push(text.slice(i, i + PER));
  const cols = chunks.length;
  const FS = cols <= 8 ? 56 : cols <= 14 ? 46 : 38;
  const CW = Math.round(FS * 1.28);
  const MK = Math.round(FS * 0.78);
  const W = Math.min(2200, Math.max(1100, 900 + cols * (CW + 16)));
  const H = 1500;
  const BW = W - 200, BH = H - 200;
  const LEFT = Math.max(50, Math.round((BW - (110 + cols * (CW + 16))) / 2));

  const colHtml = (chunk) => {
    const parts = [...chunk].map((ch) => {
      if (ch === " ") return '<span class="sp"></span>';
      if (/[\u3400-\u9fff]/.test(ch)) {
        return FONT.has(ch) ? '<span class="zi">' + ch.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>" : pngMark(ch);
      }
      return pngMark(ch);
    }).join("");
    return '<div class="col">' + parts + "</div>";
  };
  const pairDiv = '<div class="pair"><svg viewBox="0 0 34 1000" preserveAspectRatio="none">' +
    '<path class="g1" d="M10 0v1000"/><path class="g2" d="M24 0v1000"/>' +
    '<path class="red" d="M17 20v960"/>' +
    '<path class="xx" d="M5 28l9 9-9 9M29 28l-9 9 9 9M5 956l9 9-9 9M29 956l-9 9 9 9"/></svg></div>';
  const co = [];
  chunks.forEach((c, i) => {
    co.push(colHtml(c));
    if (cols >= 6 && (i === Math.floor(cols / 3) || i === Math.floor((cols * 2) / 3))) co.push(pairDiv);
  });
  const title = '<div class="title">' + [...titleChars].map((c) => '<span class="ti zi">' + c + "</span>").join("") + "</div>";
  const omen = '<div class="omen"><div class="ocol"><span class="ozi zi">吉</span></div><div class="opair"><svg viewBox="0 0 26 240"><path class="red" d="M13 10v220"/><path class="xx" d="M4 16l8 8-8 8M22 16l-8 8 8 8M4 216l8 8-8 8M22 216l-8 8 8 8"/></svg></div><div class="ocol"><span class="ozi zi">亡</span></div></div>';

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>甲骨 C++ 程序</title><style>
@font-face{font-family:"Oracular";src:url(data:font/woff2;base64,${fontB64}) format("woff2");font-display:block}
*{box-sizing:border-box}html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{background:radial-gradient(1300px 700px at 50% 46%,#342b1f 0%,#1d1811 55%,#0d0a07 100%);display:flex;align-items:center;justify-content:center;font-family:ui-serif,serif}
.bone{position:relative;width:${BW}px;height:${BH}px;background:radial-gradient(90% 70% at 42% 12%,#fef9ec 0%,#f9f1dc 30%,#f2e4c8 56%,#e7d2ab 78%,#d9be94 92%,#ccb185 100%),radial-gradient(40% 30% at 70% 82%,rgba(150,102,52,.26),transparent 72%),radial-gradient(30% 40% at 14% 55%,rgba(150,106,56,.20),transparent 75%);clip-path:polygon(6% 2.4%,22% 0.6%,44% 1.6%,68% 0.4%,88% 1.2%,97.4% 3.2%,99.2% 12%,97.6% 26%,99.4% 42%,97.2% 58%,99.2% 74%,96.6% 90%,92% 97.6%,72% 99%,50% 97.6%,28% 99.2%,9% 97.8%,2.2% 91%,3.6% 74%,1.4% 56%,3% 38%,1.6% 20%,2.8% 7%);box-shadow:0 70px 170px rgba(0,0,0,.82),0 12px 34px rgba(0,0,0,.55),inset 0 0 90px rgba(120,86,48,.34),inset 0 0 22px rgba(70,45,20,.6)}
.grain{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.22}
.mottle{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.7;background:radial-gradient(20% 14% at 10% 14%,rgba(148,106,56,.34),transparent 70%),radial-gradient(16% 11% at 88% 22%,rgba(148,106,56,.24),transparent 70%),radial-gradient(22% 15% at 82% 80%,rgba(148,106,56,.30),transparent 72%),radial-gradient(18% 12% at 20% 88%,rgba(148,106,56,.26),transparent 70%)}
.reg{position:absolute;top:92px;left:${LEFT}px;right:auto;display:flex;flex-direction:row-reverse;align-items:flex-start;gap:16px}
.title{display:flex;flex-direction:column;align-items:center;gap:24px;margin:0 14px 0 24px}
.title .ti{font-size:92px;color:#241607;line-height:1.02;text-shadow:0 3px 0 rgba(255,253,244,.88),0 -1px 1px rgba(70,44,16,.5),0 5px 7px rgba(60,38,16,.32)}
.title:after{content:"";width:3px;height:${BH - 260}px;background:linear-gradient(#6a4a26,rgba(106,74,38,.35) 55%,transparent);opacity:.5}
.col{display:flex;flex-direction:column;align-items:center;gap:5px;width:${CW}px}
.col .zi{font-family:"Oracular",ui-serif,serif;font-size:${FS}px;line-height:1.0;color:#281908;text-shadow:0 1.5px 0 rgba(255,252,242,.8),0 -1px 1px rgba(74,48,20,.42),0 2px 3px rgba(70,44,18,.22)}
.col .mk{width:${MK}px;height:${MK}px;display:flex;align-items:center;justify-content:center}
.col .mk svg{width:${Math.round(MK * 0.88)}px;height:${Math.round(MK * 0.88)}px;fill:none;stroke:#37250f;stroke-width:2.6;stroke-linecap:round;filter:drop-shadow(0 1.5px 0 rgba(255,252,242,.6))}
.col .sp{width:100%;height:${Math.round(FS * 0.3)}px}
.pair{width:36px;display:flex;justify-content:center;padding-top:70px}
.pair svg{width:32px;height:680px}
.pair .g1,.pair .g2{stroke:#4b3115;stroke-width:2.2;fill:none;opacity:.55}
.pair .red{stroke:#8a2b1a;stroke-width:2.4;fill:none;opacity:.9}
.pair .xx{stroke:#8a2b1a;stroke-width:2.8;fill:none;opacity:.95}
.omen{position:absolute;left:80px;bottom:150px;display:flex;align-items:flex-start;gap:6px}
.ocol{display:flex;flex-direction:column;align-items:center}
.ozi{font-family:"Oracular",ui-serif,serif;font-size:92px;color:#281908;line-height:1.05;text-shadow:0 2.5px 0 rgba(255,252,242,.85),0 -1px 1px rgba(74,48,20,.45),0 4px 5px rgba(70,44,18,.28)}
.opair{width:30px;padding-top:8px}.opair svg{width:28px;height:200px}
.opair .red{stroke:#8a2b1a;stroke-width:2.4;fill:none;opacity:.9}.opair .xx{stroke:#8a2b1a;stroke-width:2.8;fill:none;opacity:.95}
.burn{position:absolute;pointer-events:none;filter:blur(10px);mix-blend-mode:multiply;opacity:.45;width:300px;height:240px;left:180px;top:420px;background:radial-gradient(closest-side,rgba(110,64,24,.6),rgba(140,92,44,.26) 55%,transparent 78%)}
.scorch{position:absolute;pointer-events:none;mix-blend-mode:multiply;opacity:.65;width:74px;height:60px;left:300px;top:490px;background:radial-gradient(circle at 50% 50%,rgba(44,26,9,.85) 0 16%,rgba(84,50,20,.5) 38%,transparent 66%)}
.seal{position:absolute;right:96px;bottom:84px;width:120px;height:120px;border:6px solid #8a2b1a;border-radius:5px;display:flex;align-items:center;justify-content:center;opacity:.88;transform:rotate(4deg);box-shadow:0 0 0 2px rgba(138,43,26,.16),inset 0 0 14px rgba(138,43,26,.22)}
.seal span{font-family:"Oracular",serif;font-size:84px;color:#8a2b1a;line-height:1}
.cracks{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply}
.cracks path{fill:none;stroke:#6b4824;stroke-linecap:round;opacity:.6}
</style></head><body><div class="bone">
<svg class="grain" viewBox="0 0 ${BW} ${BH}" preserveAspectRatio="none"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="17"/><feColorMatrix type="saturate" values="0"/></filter><rect width="${BW}" height="${BH}" filter="url(#n)" opacity="0.6"/></svg>
<div class="mottle"></div><div class="burn"></div><div class="scorch"></div>
<svg class="cracks" viewBox="0 0 ${BW} ${BH}" preserveAspectRatio="none"><path d="M300 340 C 380 420, 350 520, 420 610 C 470 680, 450 760, 490 840" stroke-width="3.2"/><path d="M420 610 C 490 630, 540 680, 600 700" stroke-width="2"/><path d="M300 340 C 270 270, 265 200, 230 150" stroke-width="1.4"/><path d="M${BW - 300} 200 C ${BW - 340} 300, ${BW - 320} 400, ${BW - 360} 490" stroke-width="1.4"/><path d="M${BW - 220} 1080 C ${BW - 180} 1140, ${BW - 190} 1200, ${BW - 160} 1260" stroke-width="1.1"/></svg>
<div class="reg">${title}${co.join("")}</div>${omen}<div class="seal"><span>貞</span></div>
</div></body></html>`;
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const base = path.basename(opts.srcPath || "program").replace(/\.jcpv?$/i, "");
  const htmlPath = path.join(BUILD_DIR, "png-" + base + ".html");
  const tmpPng = path.join(BUILD_DIR, "png-" + base + ".tmp.png");
  fs.writeFileSync(htmlPath, html, "utf8");
  try { if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng); } catch (e) {}
  const profileDir = path.join(BUILD_DIR, "edge-profile");
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
  const r = spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-sandbox",
    "--user-data-dir=" + profileDir,
    "--window-size=" + W + "," + H, "--force-device-scale-factor=1",
    "--screenshot=" + tmpPng, "file:///" + htmlPath.replaceAll("\\", "/"),
  ], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (!fs.existsSync(tmpPng)) throw new Error("浏览器截图失败（" + (r.error ? r.error.message : "exit " + r.status) + (r.stderr ? "：" + String(r.stderr).trim().split("\n").slice(-2).join(" | ") : "") + "）");
  const out = opts.out ? path.resolve(opts.out) : path.join(path.dirname(path.resolve(opts.srcPath)), base + ".png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(tmpPng, out);
  return out;
}

/* ---------------------------- 编译管线（供 CLI 与工作台共用） ---------------------------- */
function resolveModule(name, baseDir) {
  const cands = [];
  if (baseDir) {
    cands.push(path.join(baseDir, name + ".jcp"));
    cands.push(path.join(baseDir, "lib", name + ".jcp"));
  }
  cands.push(path.join(HERE, "lib", name + ".jcp"));
  cands.push(path.join(process.cwd(), "lib", name + ".jcp"));
  for (const p of cands) { try { if (fs.existsSync(p)) return { path: p }; } catch (e) {} }
  if (globalThis.__JCP_STDLIB && globalThis.__JCP_STDLIB[name]) return { virtual: true, src: globalThis.__JCP_STDLIB[name] };
  return null;
}
function loadProgram(src, srcPath, seen = new Set()) {
  const toks = lex(src);
  const ast = parse(toks);
  const funcs = [];
  for (const name of ast.imports || []) {
    if (seen.has(name)) continue;
    seen.add(name);
    const r = resolveModule(name, srcPath ? path.dirname(path.resolve(srcPath)) : null);
    if (!r) throw new CompileError("找不到模块「" + name + "」（放到 lib/" + name + ".jcp）", 1, 1);
    const msrc = r.virtual ? r.src : fs.readFileSync(r.path, "utf8");
    const mast = loadProgram(msrc, r.virtual ? null : r.path, seen);
    for (const f of mast.funcs) {
      if (f.name === "貞") throw new CompileError("模块「" + name + "」不能定义入口函数 貞", 1, 1);
      funcs.push(f);
    }
  }
  funcs.push(...ast.funcs);
  return { funcs, toks, ast: { t: "program", funcs, imports: [] } };
}
function buildProgram(src, srcPath) {
  const srcLines = src.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("；"));
  const loaded = loadProgram(src, srcPath);
  const sem = check(loaded.ast);
  const prog = compile(loaded.ast, sem.funcs);
  const jcb = listing(prog);
  return { srcLines, toks: loaded.toks, ast: loaded.ast, sem, prog, jcb };
}

/* ---------------------------- 一体化工作台：编写 · 编译 · 运行 ---------------------------- */
function makeLineReader() {
  const dec = new StringDecoder("utf8");
  let buf = "", pending = [], waiters = [], closed = false, started = false;
  const onData = (chunk) => {
    const s = dec.write(chunk);
    for (const ch of s) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        if (waiters.length) waiters.shift()(buf);
        else pending.push(buf);
        buf = "";
      } else {
        buf += ch;
        if (process.stdin.isTTY) process.stdout.write(ch);
      }
    }
  };
  const onEnd = () => {
    closed = true;
    if (buf.length) { pending.push(buf); buf = ""; }
    while (waiters.length) waiters.shift()(null);
  };
  function start() {
    if (started) return;
    started = true;
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  }
  return {
    async next(prompt) {
      if (prompt) process.stdout.write(prompt);
      start();
      if (pending.length) return pending.shift();
      if (closed) return null;
      return new Promise((r) => waiters.push(r));
    },
    detach() {
      try { process.stdin.removeListener("data", onData); process.stdin.removeListener("end", onEnd); } catch (e) {}
      try { process.stdin.pause(); } catch (e) {}
    },
  };
}

const EXAMPLES = {
  "三加二": "san.jcp",
  "大有年": "tian.jcp",
  "卜雨": "bu.jcp",
  "復循环": "xun.jcp",
  "作天人": "han.jcp",
  "從循环": "cong.jcp",
  "貪食蛇": "snake.jcp",
};

function findExample(file) {
  const cands = [
    path.join(HERE, file),
    path.join(path.dirname(process.execPath), "甲骨C++示例", file),
    path.join(process.cwd(), file),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return path.join(HERE, file);
}

async function workbench() {
  let src = "", name = "未命名";
  let reader = makeLineReader();
  console.log("");
  console.log("  " + paint("jcp " + VERSION, "1;36") + paint("  ·  ", "2") + paint("甲骨 C++ 一 體 機", "1"));
  console.log("  " + paint("編寫 · 編譯 · 運行", "2"));
  console.log("  " + paint("─".repeat(66), "2"));
  console.log("   逐行輸入代碼；以 : 開頭是命令");
  console.log("   :run 編譯並運行   :show 看代碼   :jcb 看字節碼   :vertical 豎排對刻");
  console.log("   :demo 示例名   :clear 清空   :save 檔名   :help   :quit 退出");
  console.log("   示例：" + Object.keys(EXAMPLES).join("、"));
  console.log("   入口函數是 貞；按甲骨習慣可寫成豎排對刻，工具支援 .jcpv 豎排源。");
  for (;;) {
    const line = await reader.next(process.stdin.isTTY ? "甲骨> " : "");
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (!text.startsWith(":")) { src += line + "\n"; continue; }
    const cmd = text.slice(1).trim();
    const parts = cmd.split(/\s+/);
    const verb = parts[0];
    const arg = parts.slice(1).join(" ");
    try {
      if (verb === "quit" || verb === "q" || verb === "exit") break;
      if (verb === "version") { console.log("   jcp " + VERSION + " · 甲骨 C++ 一體機"); continue; }
      if (verb === "examples") { console.log("   示例：" + Object.keys(EXAMPLES).join("、")); continue; }
      if (verb === "help" || verb === "?") {
        console.log("   :run 編譯並運行 · :show 顯示代碼 · :jcb 字節碼 · :vertical 豎排對刻");
        console.log("   :demo 示例名 · :clear · :save 檔名 · :quit");
        continue;
      }
      if (verb === "clear") { src = ""; name = "未命名"; console.log("   已清空"); continue; }
      if (verb === "show") {
        if (!src.trim()) { console.log("   （空）"); continue; }
        src.split(/\r?\n/).forEach((l, i) => console.log("   " + String(i + 1).padStart(3, " ") + " │ " + l));
        continue;
      }
      if (verb === "png") {
        if (!src.trim()) { console.log("   （空）"); continue; }
        try {
          const tmp = path.join(BUILD_DIR, "workbench-src.jcp");
          fs.mkdirSync(BUILD_DIR, { recursive: true });
          fs.writeFileSync(tmp, src, "utf8");
          const out = await generatePng(src, { srcPath: tmp, out: arg ? path.resolve(arg) : null });
          console.log("   已生成 " + out);
        } catch (e) { console.log("   PNG 失败 " + e.message); }
        continue;
      }
      if (verb === "vertical") {
        if (!src.trim()) { console.log("   （空）"); continue; }
        const v = toVertical(src).trimEnd().split("\n").map((l) => "   " + l).join("\n");
        console.log(v);
        continue;
      }
      if (verb === "demo") {
        const hit = Object.keys(EXAMPLES).find((k) => k.includes(arg) || EXAMPLES[k].includes(arg) || arg.includes(k));
        if (!hit) { console.log("   沒有這個示例：" + arg); continue; }
        const file = findExample(EXAMPLES[hit]);
        src = fs.readFileSync(file, "utf8");
        name = hit;
        console.log("   已載入示例 " + hit + "（" + EXAMPLES[hit] + "）");
        continue;
      }
      if (verb === "save") {
        if (!src.trim()) { console.log("   （空）"); continue; }
        const out = path.resolve(arg || name + ".jcp");
        fs.writeFileSync(out, src, "utf8");
        console.log("   已保存 " + out);
        continue;
      }
      if (verb === "jcb" || verb === "run") {
        if (!src.trim()) { console.log("   （空）"); continue; }
        const built = buildProgram(src, path.join(HERE, "workbench.jcp"));
        const nIns = built.prog.chunks.reduce((n, c) => n + c.code.length, 0);
        console.log("   詞法 " + built.toks.length + " 令牌 · 語法 " + built.ast.funcs.length + " 函數 · 語義 " + built.sem.decls + " 聲明");
        console.log("   字節碼 " + nIns + " 條 · 槽位 " + built.prog.slotCount + " · 字符串 " + built.prog.strings.length);
        fs.mkdirSync(BUILD_DIR, { recursive: true });
        const jcbPath = path.join(BUILD_DIR, "workbench.jcb");
        fs.writeFileSync(jcbPath, built.jcb, "utf8");
        console.log("   產物 " + jcbPath);
        if (verb === "jcb") {
          console.log(built.jcb.split("\n").map((l) => "   │ " + l).join("\n"));
          continue;
        }
        reader.detach();
        const result = await vm(built.prog);
        reader = makeLineReader();
        if (result.error) console.log("   運行錯誤 " + result.error);
        console.log("   退出碼 " + result.exit + " · 指令 " + result.steps);
        continue;
      }
      console.log("   未知命令：" + verb + "（:help 看幫助）");
    } catch (e) {
      console.log("   錯誤 " + (e && e.message ? e.message : e));
    }
  }
  reader.detach();
  console.log("   再會");
}

/* ---------------------------- 本地 Web GUI ---------------------------- */
const GUI_HTML = (fontB64, fontChars, version) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>甲骨 C++ GUI</title>
<style>
@font-face{font-family:"Oracular";src:url(data:font/woff2;base64,${fontB64}) format("woff2");font-display:swap}
:root{--bg:#15110c;--paper:#f4ecdd;--ink:#2b2118;--brown:#6b5741;--rust:#8a3a22;--green:#2f5d43;--dark:#241d14}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:radial-gradient(1200px 700px at 50% -10%,#2d261b 0%,var(--bg) 62%);color:#e9e0cc;font-family:ui-serif,"Songti SC","SimSun",serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(180,150,110,.18);flex-wrap:wrap}
.brand{font-size:15px;letter-spacing:.18em;color:#f3ead6}
.brand b{color:#d8b26a}
.sub{font-size:11px;color:#9d8a6d}
.chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.chip{font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(180,150,110,.16);color:#d8c9a8}
main{display:flex;gap:12px;padding:12px;flex:1;min-height:0}
main>.panel{flex:1 1 0;min-width:0}
@media(max-width:760px){main{flex-direction:column;overflow:auto}main>.panel{min-height:280px}}
.panel{background:linear-gradient(160deg,#faf3e3,#ede0c8);color:var(--ink);border-radius:12px;display:flex;flex-direction:column;min-height:0;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45), inset 0 0 60px rgba(120,86,48,.08)}
.panel h2{margin:0;padding:9px 12px;font-size:12px;letter-spacing:.16em;color:var(--brown);font-weight:600;border-bottom:1px solid rgba(120,96,64,.22);display:flex;align-items:center;gap:8px}
.panel h2 .mini{margin-left:auto;font-size:10px;letter-spacing:.06em;color:#8d7a5c;font-weight:400}
.toolbar{display:flex;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid rgba(120,96,64,.18);align-items:center}
button{appearance:none;border:1px solid rgba(120,96,64,.38);background:rgba(255,252,244,.55);color:var(--ink);border-radius:7px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;transition:.15s}
button:hover{background:#fffaf0}
button.primary{background:var(--rust);border-color:var(--rust);color:#fdf6e8}
button.primary:hover{filter:brightness(1.08)}
button.gen{background:var(--green);border-color:var(--green);color:#f2fbf5}
select{font:inherit;font-size:12px;padding:5px 8px;border-radius:7px;border:1px solid rgba(120,96,64,.38);background:#fffaf0;color:var(--ink);max-width:190px}
.editor{flex:1;display:flex;min-height:0;background:#fffaf0;overflow:hidden}
.gutter{width:46px;padding:10px 6px 10px 0;text-align:right;font:13.5px/1.75 ui-monospace,Consolas,"Courier New",monospace;color:#a08a68;background:rgba(120,96,64,.09);overflow:hidden;user-select:none;flex-shrink:0}
.gutter div{height:23.63px}
.codebox{position:relative;flex:1;min-height:0;overflow:hidden}
.codebox pre{position:absolute;inset:0;margin:0;padding:10px 12px;overflow:auto;pointer-events:none;font:13.5px/1.75 ui-monospace,Consolas,"Courier New",monospace;white-space:pre-wrap;word-break:break-all;color:#2b2118;background:transparent;tab-size:4}
.codebox textarea{position:absolute;inset:0;width:100%;height:100%;padding:10px 12px;border:0;outline:none;resize:none;background:transparent;color:transparent;caret-color:#8a3a22;font:13.5px/1.75 ui-monospace,Consolas,"Courier New",monospace;white-space:pre-wrap;word-break:break-all;tab-size:4}
.tok-kw{color:#8a3a22;font-weight:600}
.tok-op{color:#2f5d43;font-weight:600}
.tok-num{color:#7a4a12}
.tok-str{color:#2f4a6b}
.tok-cmt{color:#9a8a6a;font-style:italic}
.tok-fn{color:#4a3f7a}
.row{display:flex;gap:8px;padding:8px 10px;border-top:1px solid rgba(120,96,64,.18);align-items:center}
.row label{font-size:11px;color:var(--brown)}
.row input{flex:1;border:1px solid rgba(120,96,64,.3);border-radius:6px;padding:5px 8px;font:12px ui-monospace,monospace;background:#fffaf0;color:var(--ink);outline:none}
.tabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid rgba(120,96,64,.18)}
.tab{font-size:11px;padding:4px 10px;border-radius:7px 7px 0 0;border:1px solid transparent;cursor:pointer;color:#7a6648}
.tab.on{background:#241d14;color:#e9e0cc;border-color:#241d14}
pre{flex:1;min-height:120px;margin:0;padding:10px 12px;overflow:auto;font:12px/1.65 ui-monospace,Consolas,monospace;background:#241d14;color:#e8e0cc;white-space:pre-wrap}
.stats{padding:6px 10px;font-size:11px;color:var(--brown);border-bottom:1px solid rgba(120,96,64,.18);min-height:26px;word-break:break-all}
.ac{display:flex;flex-wrap:wrap;gap:5px;padding:6px 10px;border-top:1px solid rgba(120,96,64,.18);background:#fff8ec;max-height:88px;overflow:auto}
.ac[hidden]{display:none}
.acitem{display:flex;align-items:baseline;gap:5px;border:1px solid rgba(120,96,64,.3);background:#fffdf6;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer}
.acitem b{color:#8a3a22;font-size:12px}
.acitem span{color:#8d7a5c;font-size:10px}
.acitem.on{background:#241d14;color:#e9e0cc;border-color:#241d14}
.acitem.on b{color:#f0c98a}.acitem.on span{color:#b9a888}
.err{color:#b23a2a}
.ok{color:#2f6b47}
.oracle{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:row-reverse;gap:9px;align-items:flex-start;background:radial-gradient(120% 60% at 40% 10%,#fdf8ea,#f0e3ca 60%,#e4d0ac);border-radius:0 0 12px 12px}
.vcol{display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0}
.vcol .zi{font-family:"Oracular",ui-serif,serif;font-size:23px;line-height:1.12;color:#2e1f0e;text-shadow:0 1px 0 rgba(255,252,240,.7)}
.vcol .mk{width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#4a3622;font:15px ui-monospace,monospace}
.vcol .gap{height:8px}
#pngWrap{flex:1;display:none;align-items:center;justify-content:center;background:#1c1710;overflow:auto;position:relative}
#png{max-width:100%;max-height:100%;object-fit:contain}
footer{padding:6px 16px 10px;font-size:11px;color:#8d7a5c}
</style></head><body>
<header>
  <div class="brand">甲 骨 <b>C++</b> · GUI</div>
  <div class="sub">本地编译器服务 · v${version}</div>
  <div class="chips"><span class="chip" id="chipState">就绪</span><span class="chip">恒 / 引 / 模块</span><span class="chip">行号 · 高亮 · 补全</span></div>
</header>
<main>
  <section class="panel">
    <h2>源码 <span class="mini">Ctrl+Enter 运行 · Ctrl+G 出图 · 支持 引 模块 / 恒 常量</span></h2>
    <div class="toolbar">
      <select id="examples"><option value="">— 载入示例 —</option></select>
      <button id="btnRun" class="primary">运行</button>
      <button id="btnCheck">检查</button>
      <button id="btnPng" class="gen">生成甲骨图</button>
      <button id="btnSavePng">保存 PNG 到桌面</button>
      <button id="btnClear">清空</button>
    </div>
    <div class="row"><label>输入（给 听 用）</label><input id="stdin" placeholder="如 dddddq（贪吃蛇按键）"></div>
    <div class="editor">
      <div class="gutter" id="gutter"></div>
      <div class="codebox">
        <pre id="hl" aria-hidden="true"></pre>
        <textarea id="src" spellcheck="false"></textarea>
      </div>
    </div>
    <div class="ac" id="ac" hidden></div>
  </section>
  <section class="panel">
    <h2>输出 / 字节码 / 甲骨预览 <span class="mini" id="stats">—</span></h2>
    <div class="tabs">
      <div class="tab on" data-tab="out">运行输出</div>
      <div class="tab" data-tab="jcb">JCB1 字节码</div>
      <div class="tab" data-tab="oracle">甲骨预览（竖排·右起）</div>
      <div class="tab" data-tab="pngtab">PNG</div>
    </div>
    <div class="stats" id="line"></div>
    <pre id="out">点「运行」编译并在内置虚拟机里跑。</pre>
    <pre id="jcb" style="display:none"></pre>
    <div class="oracle" id="oracle" style="display:none"></div>
    <div id="pngWrap"><img id="png" alt="甲骨程序图"><a id="dl" download="jiagu.png" style="position:absolute;top:8px;right:12px;color:#d8b26a;font-size:12px">下载 PNG</a></div>
  </section>
</main>
<footer>本地服务 · 仅监听 127.0.0.1 · 自动出图需要本机 Edge/Chrome · 保存 PNG 默认写到桌面</footer>
<script>
var FONT = new Set(Array.from(${JSON.stringify(fontChars)}));
var els = function(id){ return document.getElementById(id); };
var srcEl = els("src"), outEl = els("out"), jcbEl = els("jcb"), oracleEl = els("oracle"), lineEl = els("line"), statsEl = els("stats"), chip = els("chipState");
var pngWrap = els("pngWrap"), pngEl = els("png"), dlEl = els("dl"), hlEl = els("hl"), gutterEl = els("gutter");
var acEl = els("ac"), acItems = [], acIndex = 0, acToken = null;
var KW_SET = new Set(["量","無","歸","若","弗","復","從","言","卜","止","续","恒","引","字","占"]);
var OP_SET = new Set(["隹","益","去","乘","分","不","且","或"]);
var NUM_SET = new Set(["零","一","二","三","四","五","六","七","八","九","十","百","千","兩"]);
function setChip(t, ok){ chip.textContent = t; chip.style.background = ok ? "rgba(47,93,67,.55)" : "rgba(138,43,26,.5)"; }
function esc(s){ return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function markFor(ch){ return '<span class="mk">' + esc(ch === " " ? "·" : ch) + '</span>'; }
function highlightLine(line){
  var s = "", j = 0;
  while (j < line.length) {
    var ch = line[j];
    if (ch === "；" || (ch === "/" && line[j + 1] === "/")) { s += '<span class="tok-cmt">' + esc(line.slice(j)) + '</span>'; break; }
    if (ch === "「") {
      var k = line.indexOf("」", j + 1);
      if (k < 0) k = line.length;
      s += '<span class="tok-str">' + esc(line.slice(j, k + 1)) + '</span>';
      j = k + 1; continue;
    }
    if (/[0-9]/.test(ch)) {
      var m = j; while (m < line.length && /[0-9]/.test(line[m])) m++;
      s += '<span class="tok-num">' + line.slice(j, m) + '</span>'; j = m; continue;
    }
    if (/[\\u4e00-\\u9fff]/.test(ch)) {
      var cls = KW_SET.has(ch) ? "tok-kw" : (OP_SET.has(ch) ? "tok-op" : (NUM_SET.has(ch) ? "tok-num" : "tok-fn"));
      s += '<span class="' + cls + '">' + ch + '</span>'; j++; continue;
    }
    if (/[=+\\-*\\/%<>!&|]/.test(ch)) {
      var m2 = j; while (m2 < line.length && /[=+\\-*\\/%<>!&|]/.test(line[m2])) m2++;
      s += '<span class="tok-op">' + esc(line.slice(j, m2)) + '</span>'; j = m2; continue;
    }
    s += esc(ch); j++;
  }
  return s;
}
function renderOracle(src){
  var lines = src.split(/\\r?\\n/).filter(function(l){ return l.length > 0; });
  var html = "";
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i], col = "";
    for (var j = 0; j < line.length; j++) {
      var ch = line[j];
      if (ch === " ") col += '<span class="gap"></span>';
      else if (/[\\u3400-\\u9fff]/.test(ch) && FONT.has(ch)) col += '<span class="zi">' + ch + '</span>';
      else col += markFor(ch);
    }
    html += '<div class="vcol">' + col + '</div>';
  }
  oracleEl.innerHTML = html;
}
var VOCAB = [
  {w:"量",d:"int"},{w:"分",d:"float"},{w:"字",d:"string"},{w:"占",d:"bool"},
  {w:"無",d:"void"},{w:"歸",d:"return"},{w:"若",d:"if"},{w:"弗",d:"else"},
  {w:"復",d:"while"},{w:"從",d:"for"},{w:"止",d:"break"},{w:"续",d:"continue"},
  {w:"恒",d:"常量"},{w:"引",d:"模块"},{w:"言",d:"输出"},{w:"卜",d:"占断"},{w:"貞",d:"入口"},
  {w:"隹",d:"赋值/相等"},{w:"益",d:"加/拼接"},{w:"去",d:"减"},{w:"乘",d:"乘"},
  {w:"不隹",d:"不等"},{w:"且",d:"与"},{w:"或",d:"或"},{w:"對",d:"真"},{w:"非",d:"假"},
  {w:"文長",d:"字长度"},{w:"取文",d:"取子串"},{w:"解文",d:"字→量"},{w:"解浮",d:"字→分"},
  {w:"屏",d:"清屏"},{w:"书",d:"原样输出"},{w:"听",d:"读键"},{w:"歇",d:"等待"},
  {w:"大",d:"库:最大"},{w:"小",d:"库:最小"},{w:"方",d:"库:平方"},{w:"正",d:"库:绝对值"},{w:"余",d:"库:余数"},{w:"共",d:"库:数组和"},{w:"兆",d:"库:随机"}
];
function tokenAtCaret(){
  var pos = srcEl.selectionStart, v = srcEl.value, s = pos;
  while (s > 0) {
    var c = v.charCodeAt(s - 1);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 0x3400 && c <= 0x9fff)) s--;
    else break;
  }
  if (s === pos) return null;
  return { text: v.slice(s, pos), start: s, end: pos };
}
function hideAC(){ acEl.hidden = true; acItems = []; }
function paintAC(){
  var nodes = acEl.querySelectorAll(".acitem");
  nodes.forEach(function(n, i){ n.classList.toggle("on", i === acIndex); });
  if (nodes[acIndex]) { try { nodes[acIndex].scrollIntoView({ block: "nearest" }); } catch (e) {} }
}
function updateAC(force){
  var tok = tokenAtCaret();
  if (!tok) { hideAC(); return; }
  var q = tok.text;
  var matches = VOCAB.filter(function(v){ return v.w.indexOf(q) === 0 && v.w !== q; }).slice(0, 8);
  if (!matches.length) { hideAC(); return; }
  acItems = matches; acIndex = 0; acToken = tok;
  acEl.innerHTML = matches.map(function(v, i){ return '<div class="acitem' + (i === 0 ? ' on' : '') + '" data-i="' + i + '"><b>' + v.w + '</b><span>' + v.d + '</span></div>'; }).join("");
  acEl.hidden = false;
}
function chooseAC(i){
  if (!acItems[i] || !acToken) return;
  var v = srcEl.value, tok = acToken, ins = acItems[i].w;
  srcEl.value = v.slice(0, tok.start) + ins + v.slice(tok.end);
  var pos = tok.start + ins.length;
  hideAC(); updateEditor();
  srcEl.focus(); srcEl.setSelectionRange(pos, pos);
}
acEl.addEventListener("click", function(e){
  var node = e.target;
  while (node && node !== acEl) {
    if (node.className && String(node.className).indexOf("acitem") >= 0) { chooseAC(+node.getAttribute("data-i")); return; }
    node = node.parentNode;
  }
});

function updateEditor(){
  var src = srcEl.value;
  var lines = src.split("\\n");
  hlEl.innerHTML = lines.map(highlightLine).join("\\n") + "\\n";
  var g = "";
  for (var i = 1; i <= lines.length; i++) g += "<div>" + i + "</div>";
  gutterEl.innerHTML = g;
  renderOracle(src);
}
function syncScroll(){
  hlEl.scrollTop = srcEl.scrollTop; hlEl.scrollLeft = srcEl.scrollLeft;
  gutterEl.scrollTop = srcEl.scrollTop;
}
function showTab(name){
  document.querySelectorAll(".tab").forEach(function(t){ t.classList.toggle("on", t.getAttribute("data-tab") === name); });
  outEl.style.display = name === "out" ? "block" : "none";
  jcbEl.style.display = name === "jcb" ? "block" : "none";
  oracleEl.style.display = name === "oracle" ? "flex" : "none";
  pngWrap.style.display = name === "pngtab" ? "flex" : "none";
}
document.querySelectorAll(".tab").forEach(function(t){ t.addEventListener("click", function(){ showTab(t.getAttribute("data-tab")); }); });
async function api(path, body){
  var r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return await r.json();
}
async function doRun(){
  setChip("编译中…", false); outEl.textContent = "…";
  try {
    var d = await api("/api/run", { src: srcEl.value, input: els("stdin").value });
    if (!d.ok) { outEl.innerHTML = '<span class="err">' + esc(d.error) + '</span>'; lineEl.textContent = d.line ? ("第 " + d.line + " 行" + (d.col ? "，第 " + d.col + " 列" : "")) : ""; setChip("编译错误", false); return; }
    outEl.textContent = d.output || "（无输出）";
    jcbEl.textContent = d.bytecode || "";
    lineEl.textContent = "退出码 " + d.exit + (d.error ? "（运行错误：" + d.error + "）" : "");
    statsEl.textContent = d.ins + " 条指令 · 槽位 " + d.slots + " · " + d.funcs + " 个函数";
    setChip("运行完成", true);
  } catch (e) { outEl.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; setChip("出错", false); }
}
async function doCheck(){
  setChip("检查中…", false);
  try {
    var d = await api("/api/check", { src: srcEl.value });
    if (d.ok) { setChip("检查通过", true); lineEl.textContent = "词法 " + d.tokens + " 令牌 · 字节码 " + d.ins + " 条"; outEl.textContent = "✓ 词法 / 语法 / 语义 / 字节码 全部通过"; }
    else { setChip("检查失败", false); outEl.innerHTML = '<span class="err">' + esc(d.error) + '</span>'; lineEl.textContent = d.line ? ("第 " + d.line + " 行") : ""; }
  } catch (e) { setChip("出错", false); }
}
async function doPng(){
  setChip("刻图中…", false);
  try {
    var d = await api("/api/png", { src: srcEl.value, title: "龜卜龜食" });
    if (!d.ok) { outEl.innerHTML = '<span class="err">' + esc(d.error) + '</span>'; setChip("出图失败", false); return; }
    pngEl.src = d.png; dlEl.href = d.png; showTab("pngtab"); setChip("已生成 PNG", true);
  } catch (e) { setChip("出错", false); }
}
async function doSavePng(){
  setChip("保存中…", false);
  try {
    var d = await api("/api/png-save", { src: srcEl.value, title: "龜卜龜食" });
    if (!d.ok) { outEl.innerHTML = '<span class="err">' + esc(d.error) + '</span>'; setChip("保存失败", false); return; }
    lineEl.textContent = "已保存：" + d.path;
    setChip("已保存到桌面", true);
    if (d.png) { pngEl.src = d.png; dlEl.href = d.png; showTab("pngtab"); }
  } catch (e) { setChip("保存失败", false); }
}
els("btnRun").onclick = doRun; els("btnCheck").onclick = doCheck; els("btnPng").onclick = doPng; els("btnSavePng").onclick = doSavePng;
els("btnClear").onclick = function(){ srcEl.value = ""; hideAC(); updateEditor(); };
srcEl.addEventListener("input", function(){ updateEditor(); updateAC(); });
srcEl.addEventListener("scroll", syncScroll);
srcEl.addEventListener("keydown", function(e){
  if (!acEl.hidden) {
    if (e.key === "ArrowDown") { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; paintAC(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; paintAC(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseAC(acIndex); return; }
    if (e.key === "Escape") { hideAC(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === " ") { e.preventDefault(); updateAC(true); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doRun(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) { e.preventDefault(); doPng(); }
});
function loadExamples(){
  fetch("/api/examples").then(function(r){ return r.json(); }).then(function(list){
    var sel = els("examples");
    list.forEach(function(x){ var o = document.createElement("option"); o.value = x.name; o.textContent = x.title; sel.appendChild(o); });
    sel.onchange = function(){
      if (!sel.value) return;
      fetch("/api/load?name=" + encodeURIComponent(sel.value)).then(function(r){ return r.json(); }).then(function(d){
        if (d.ok) { srcEl.value = d.source; updateEditor(); setChip("已载入 " + d.name, true); }
      });
    };
  });
}
loadExamples();
fetch("/api/default").then(function(r){ return r.json(); }).then(function(d){ if (d.ok) { srcEl.value = d.source; updateEditor(); } });
</script></body></html>
`;

const MIME = {
  ".png": "image/png"
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunk = "", size = 0;
    req.on("data", (b) => { size += b.length; if (size > 2 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); } chunk += b; });
    req.on("end", () => resolve(chunk));
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}
function diagOf(e) {
  return { ok: false, error: e && e.message ? e.message : String(e), line: e && e.line, col: e && e.col };
}

async function startGui(argv) {
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? parseInt(argv[portIdx + 1], 10) : 7801;
  const noOpen = argv.includes("--no-open");
  const fontB64 = getFontB64();
  if (!fontB64) throw new Error("找不到甲骨字体（可用 JCP_FONT 指定 orac.woff2 路径）");
  const html = GUI_HTML(fontB64, [...FONT].join(""), VERSION);
  const demoFiles = (() => {
    try {
      return fs.readdirSync(HERE).filter((f) => f.endsWith(".jcp") && !f.startsWith("t-")).sort();
    } catch (e) { return []; }
  })();
  const loadDemo = (name) => {
    const f = path.join(HERE, name);
    if (!demoFiles.includes(name)) throw new Error("没有这个示例：" + name);
    return fs.readFileSync(f, "utf8");
  };
  const gui = async (src) => {
    const built = buildProgram(src, path.join(HERE, "gui.jcp"));
    const r = await vm(built.prog, { input: "", silent: true });
    return {
      ok: true,
      output: r.out.join("\n"),
      bytecode: built.jcb,
      exit: r.exit,
      error: r.error,
      ins: built.prog.chunks.reduce((n, c) => n + c.code.length, 0),
      slots: built.prog.slotCount,
      funcs: built.ast.funcs.length,
    };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/examples") {
        json(res, 200, demoFiles.map((f) => {
          const src = fs.readFileSync(path.join(HERE, f), "utf8");
          const first = (src.split(/\r?\n/).find((l) => l.trim()) || "").replace(/^[；;]\s*/, "");
          return { name: f, title: f + (first ? " · " + first : "") };
        }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/load") {
        try { json(res, 200, { ok: true, name: url.searchParams.get("name"), source: loadDemo(url.searchParams.get("name")) }); }
        catch (e) { json(res, 404, diagOf(e)); }
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/default") {
        try { json(res, 200, { ok: true, name: "san.jcp", source: loadDemo("san.jcp") }); }
        catch (e) { json(res, 200, { ok: false, error: e.message }); }
        return;
      }
      if (req.method === "POST" && (url.pathname === "/api/run" || url.pathname === "/api/check" || url.pathname === "/api/png" || url.pathname === "/api/png-save")) {
        const body = JSON.parse((await readBody(req)) || "{}");
        const src = String(body.src || "");
        if (url.pathname === "/api/png-save") {
          try {
            const tmp = path.join(BUILD_DIR, "gui-save-" + Date.now() + ".png");
            await generatePng(src, { out: tmp, title: body.title || "龜卜龜食", srcPath: "gui.jcp" });
            const home = process.env.USERPROFILE || ((process.env.HOMEDRIVE || "") + (process.env.HOMEPATH || ""));
            let dir = process.env.JCP_SAVE_DIR || path.join(home, "Desktop");
            try { if (!fs.existsSync(dir)) dir = BUILD_DIR; } catch (e) { dir = BUILD_DIR; }
            fs.mkdirSync(dir, { recursive: true });
            const d = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
            const outPath = path.join(dir, "甲骨-" + stamp + ".png");
            fs.copyFileSync(tmp, outPath);
            const b64 = fs.readFileSync(outPath).toString("base64");
            json(res, 200, { ok: true, path: outPath, png: "data:image/png;base64," + b64 });
          } catch (e) { json(res, 200, diagOf(e)); }
          return;
        }
        if (url.pathname === "/api/check") {
          try {
            const built = buildProgram(src, path.join(HERE, "gui.jcp"));
            json(res, 200, { ok: true, tokens: built.toks.length - 1, ins: built.prog.chunks.reduce((n, c) => n + c.code.length, 0), slots: built.prog.slotCount });
          } catch (e) { json(res, 200, diagOf(e)); }
          return;
        }
        if (url.pathname === "/api/run") {
          try { json(res, 200, await gui(src)); }
          catch (e) { json(res, 200, diagOf(e)); }
          return;
        }
        try {
          const out = path.join(BUILD_DIR, "gui-" + Date.now() + ".png");
          const p = await generatePng(src, { out, title: body.title || "龜卜龜食", srcPath: "gui.jcp" });
          const b64 = fs.readFileSync(p).toString("base64");
          json(res, 200, { ok: true, png: "data:image/png;base64," + b64, path: p });
        } catch (e) { json(res, 200, diagOf(e)); }
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (e) {
      try { json(res, 500, diagOf(e)); } catch (e2) {}
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const url = "http://127.0.0.1:" + port + "/";
  console.log("  " + paint("甲骨 C++ GUI", "1;36") + " 已启动： " + paint(url, "1;4"));
  console.log("  " + paint("Ctrl+C 退出", "2"));
  if (!noOpen) {
    try {
      const br = findBrowser();
      if (br) {
        const child = spawnSync(br, ["--app=" + url, "--new-window"], { stdio: "ignore", timeout: 5000 });
        if (child.error) console.log("  请手动打开：" + url);
      } else {
        const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["open", [url]];
        spawnSync(opener[0], opener[1], { stdio: "ignore", timeout: 5000 });
      }
    } catch (e) {}
  }
  await new Promise(() => {});
}

/* ---------------------------- CLI ---------------------------- */

/* ---------------------------- CLI ---------------------------- */
function printHelp() {
  console.log("");
  console.log("  " + paint("jcp", "1;36") + " " + VERSION + " · 甲骨 C++ 编译器（现代版）");
  console.log("");
  console.log("  用法");
  console.log("    jcp <源.jcp>              编译并运行");
  console.log("    jcp run <源.jcp>          编译并运行（同默认）");
  console.log("    jcp check <源.jcp>        只做词法/语法/语义/字节码检查");
  console.log("    jcp build <源.jcp>        只生成 JCB1 字节码");
  console.log("    jcp repl                  进入一体机（编写 · 编译 · 运行）");
  console.log("    jcp gui [--port 7801]     打开图形界面（本地 Web GUI，默认应用窗口打开）");
  console.log("    jcp examples              列出内置示例");
  console.log("    jcp png <源.jcp> [-o 输出.png] [--title …]   自动生成甲骨程序图");
  console.log("    jcp version               版本");
  console.log("    jcp help                  本帮助");
  console.log("");
  console.log("  选项");
  console.log("    --quiet  只留程序输出      --brief  不打印字节码清单");
  console.log("    --emit   打印字节码        --save <文件>  指定字节码输出");
  console.log("    --vertical / --to-vertical <文件>   竖排显示 / 导出 .jcpv");
  console.log("    --png  编译/运行的同时生成甲骨程序 PNG");
  console.log("");
  console.log("  语法速查");
  console.log("    量 整数   無 无返回   歸 返回   若/弗 if/else   復/從 while/for");
  console.log("    言 输出   卜 占断     吉 1       貞 入口");
  console.log("    隹 赋值/相等（＝）     益 加（＋）   去 减（－）   乘 乘（×）   分 除（÷）");
  console.log("    不隹 不等（≠）   且/或 与/或（&& ||）   止 break   续 continue");
  console.log("    类型：量 int · 分 float · 字 string · 占 bool（数组同理）");
  console.log("    浮点：三·一四 / 3.14    布尔：對 / 非    恒 常量 隹 值");
  console.log("    引 模块名（lib/模块名.jcp）");
  console.log("    标准库：引 學;（大 小 方 正 余）  引 卜;（卜 隨機）");
  console.log("    多位数：十六 / 二十 / 一百零五；  < > <= >= % 仍用符号");
  console.log("");
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    console.log("用法：node jcp.mjs <源.jcp> [--emit] [--save out.jcb] [--quiet] [--brief]");
    process.exit(args.length ? 0 : 2);
  }
  const SUB = args[0];
  if (SUB === "version" || SUB === "--version" || SUB === "-v") {
    console.log(paint("jcp", "1;36") + " " + VERSION + " · 甲骨 C++ 编译器");
    return;
  }
  if (SUB === "help") { printHelp(); return; }
  if (SUB === "examples") {
    const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".jcp") && !f.startsWith("t-"));
    console.log(paint("内置示例", "1;36"));
    for (const f of files) {
      let first = "";
      try { first = fs.readFileSync(path.join(HERE, f), "utf8").split(/\r?\n/).find((l) => l.trim()) || ""; } catch (e) {}
      console.log("  " + f.padEnd(16) + paint(first.replace(/^[；;]\s*/, ""), "2"));
    }
    return;
  }
  if (SUB === "repl") { await workbench(); return; }
  if (SUB === "gui") { await startGui(args.slice(1)); return; }
  if (SUB === "png") {
    const r2 = args.slice(1);
    const srcArg = r2.find((a) => !a.startsWith("--"));
    if (!srcArg) { console.error("  " + paint("错误", "1;31") + "  jcp png <源.jcp> [-o 输出.png] [--title 龜卜龜食]"); process.exit(2); }
    const oi = r2.indexOf("-o") >= 0 ? r2.indexOf("-o") : r2.indexOf("--out");
    const ti = r2.indexOf("--title");
    try {
      const sp = path.resolve(srcArg);
      const src = sourceFromFile(sp);
      console.log("  正在生成程序 PNG …");
      const out = await generatePng(src, { out: oi >= 0 ? r2[oi + 1] : null, title: ti >= 0 ? r2[ti + 1] : null, srcPath: sp });
      console.log("  " + paint("✓", "1;32") + " 已生成 " + out);
    } catch (e) {
      console.error("  " + paint("错误", "1;31") + "  " + (e && e.message ? e.message : e));
      process.exit(1);
    }
    return;
  }
  if (args.includes("--workbench")) { await workbench(); return; }

  const rest = (SUB === "run" || SUB === "check" || SUB === "build") ? args.slice(1) : args;
  const checkOnly = SUB === "check";
  const buildOnly = SUB === "build";
  const srcArg = rest.find((a) => !a.startsWith("--"));
  if (!srcArg) { console.error("  " + paint("错误", "1;31") + "  缺少源文件（jcp help 看用法）"); process.exit(2); }
  const srcPath = path.resolve(srcArg);
  const quiet = rest.includes("--quiet");
  const emit = rest.includes("--emit");
  const brief = rest.includes("--brief");
  const saveIdx = rest.indexOf("--save");
  const base = path.basename(srcPath).replace(/\.jcpv?$/i, "");
  fs.mkdirSync(path.join(HERE, "build"), { recursive: true });
  const jcbPath = saveIdx >= 0 && rest[saveIdx + 1] ? path.resolve(rest[saveIdx + 1]) : path.join(HERE, "build", base + ".jcb");

  if (!quiet) {
    console.log("");
    console.log("  " + paint("jcp " + VERSION, "1;36") + paint("  ·  ", "2") + paint("甲骨 C++ 编译器", "1") + "    " + paint("源：" + path.basename(srcPath), "2"));
    console.log("  " + paint("─".repeat(66), "2"));
  }

  let result = null;
  let sourceForDiag = "";
  try {
    const src = sourceFromFile(srcPath);
    sourceForDiag = src;

    const toVertIdx = rest.indexOf("--to-vertical");
    if (toVertIdx >= 0 && rest[toVertIdx + 1]) {
      const out = path.resolve(rest[toVertIdx + 1]);
      fs.writeFileSync(out, toVertical(src), "utf8");
      console.log("  " + paint("✓", "1;32") + " 竖排源已写出 " + out + "（.jcpv：列自右向左，字自上而下）");
      process.exit(0);
    }
    if (rest.includes("--vertical")) {
      console.log(toVertical(src).trimEnd());
      process.exit(0);
    }

    const built = buildProgram(src, srcPath);
    fs.writeFileSync(jcbPath, built.jcb, "utf8");
    if (rest.includes("--png")) {
      try {
        const pngOut = await generatePng(src, { srcPath, title: (rest[rest.indexOf("--title") + 1] || null), out: rest.includes("--png-out") ? rest[rest.indexOf("--png-out") + 1] : null });
        console.log("  " + paint("✓ PNG", "1;32") + "  " + pngOut);
      } catch (e) {
        console.error("  " + paint("PNG 失败", "1;31") + "  " + e.message);
      }
    }
    const nIns = built.prog.chunks.reduce((n, c) => n + c.code.length, 0);
    if (!quiet) {
      console.log("  " + paint("✓ 词法", "1;32") + "   " + (built.toks.length - 1) + " 个令牌");
      console.log("  " + paint("✓ 语法", "1;32") + "   " + built.ast.funcs.length + " 个函数：" + built.ast.funcs.map((f) => f.name + "(" + f.params.length + ")").join("、"));
      console.log("  " + paint("✓ 语义", "1;32") + "   " + built.sem.decls + " 个声明 · 符号表通过 · 入口「貞」就位");
      console.log("  " + paint("✓ 字节码", "1;32") + " " + nIns + " 条指令 · " + built.prog.strings.length + " 个字符串 · 槽位 " + built.prog.slotCount);
      console.log("  " + paint("✓ 产物", "1;32") + "   " + path.relative(process.cwd(), jcbPath));
      if (!brief && !checkOnly && !buildOnly) {
        console.log("  " + paint("─".repeat(66), "2"));
        console.log(built.jcb.split("\n").map((l) => "  │ " + l).join("\n"));
        console.log("  " + paint("─".repeat(66), "2"));
      }
      if (checkOnly) { console.log("\n  " + paint("检查通过", "1;32") + "（未运行）\n"); process.exit(0); }
      if (buildOnly) { console.log("\n  " + paint("构建完成", "1;32") + " " + jcbPath + "\n"); process.exit(0); }
      console.log("  " + paint("▶ 运行", "1;36"));
    }
    result = await vm(built.prog);
    if (!quiet) {
      console.log("  " + paint("退出码", "1") + " " + result.exit + (result.error ? paint("（错误：" + result.error + "）", "1;31") : ""));
      console.log("  " + paint("完成", "1;32") + "  甲骨源 → AST → 字节码 → 虚拟机真跑\n");
    }
    if (emit) console.log(built.jcb);
    if (result.error) console.error("\n  " + paint("运行错误", "1;31") + "  " + result.error + "\n");
  } catch (e) {
    if (e instanceof CompileError && e.line) {
      console.error("\n  " + paint("编译错误", "1;31") + "  第 " + e.line + " 行" + (e.col ? "，第 " + e.col + " 列" : ""));
      const srcLine = (sourceForDiag || "").split(/\r?\n/)[e.line - 1];
      if (srcLine !== undefined) {
        console.error("  " + paint(String(e.line).padStart(4), "2") + " │ " + srcLine);
        if (e.col) console.error("       │ " + " ".repeat(Math.max(0, e.col - 1)) + paint("^", "1;31"));
      }
      console.error("  " + paint("原因", "1;31") + "  " + e.message + "\n");
    } else if (e && typeof e.message === "string" && /^(语义：|代码生成：|词法：|语法：)/.test(e.message)) {
      console.error("\n  " + paint("编译错误", "1;31") + "  " + e.message + "\n");
    } else {
      console.error("\n  " + paint("内部错误", "1;31") + "  " + (e && e.message ? e.message : e) + "\n");
    }
    process.exit(3);
  }
  process.exit(result.error ? 1 : result.exit);
}

main().catch((e) => {
  console.error("\n  " + paint("错误", "1;31") + "  " + (e && e.message ? e.message : e) + "\n");
  process.exit(3);
});
