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
const VERSION = "0.7.0";
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
const KW = { 量: "int", 無: "void", 歸: "return", 若: "if", 弗: "else", 復: "while", 從: "for", 言: "print", 卜: "assert", 止: "break", 续: "continue" };
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
      add("num", parseNumeral(src.slice(i, j)), start);
      i = j; continue;
    }
    if (NUM[c] !== undefined) { add("num", NUM[c]); i++; continue; }
    if (/[0-9]/.test(c)) {
      const start = i;
      let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++;
      add("num", +src.slice(i, j), start); i = j; continue;
    }
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
    fail("期望类型 量/無");
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
    if (at("kw", "量")) {
      p++; const name = eat("id").v;
      if (at("op", "[")) {                     /* 数组声明：量 名[长度]; */
        p++; const size = expr(); eat("op", "]"); eat("op", ";");
        return { t: "arrdecl", name, size };
      }
      let init = null;
      if (at("op", "=") || at("op", "隹")) { p++; init = expr(); }
      eat("op", ";");
      return { t: "decl", name, init };
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
        if (at("kw", "量")) {
          p++; const n = eat("id").v;
          if (at("op", "[")) { fail("從 的初始化里不支持数组声明"); }
          let e = null; if (at("op", "=") || at("op", "隹")) { p++; e = expr(); }
          init = { t: "decl", name: n, init: e };
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
    if (at("num")) { const v = toks[p++].v; return { t: "num", v }; }
    if (at("str")) { const v = toks[p++].v; return { t: "str", v }; }
    if (at("id")) { const v = toks[p++].v; return { t: "id", v }; }
    fail("表达式错误");
  }
  function top() {
    const ty = type();
    const name = eat("id").v;
    eat("op", "(");
    const params = [];
    if (!at("op", ")")) {
      for (;;) { const pt = type(); const pn = eat("id").v; params.push({ type: pt, name: pn }); if (at("op", ",")) { p++; continue; } break; }
    }
    eat("op", ")");
    return { t: "func", ret: ty, name, params, body: block() };
  }
  const funcs = [];
  while (!at("eof")) funcs.push(top());
  return { t: "program", funcs };
}

/* ---------------------------- 语义检查 ---------------------------- */
const BUILTINS = {
  "屏": { argc: 0 },
  "书": { argc: 1 },
  "听": { argc: 0 },
  "聽": { argc: 0 },   /* 甲骨字形别名 */
  "歇": { argc: 1 },
};

function check(ast) {
  const funcs = new Map();
  for (const f of ast.funcs) {
    if (funcs.has(f.name)) throw new Error(`语义：函数重复定义「${f.name}」`);
    if (BUILTINS[f.name]) throw new Error(`语义：函数名与内建冲突「${f.name}」`);
    funcs.set(f.name, f);
  }
  if (!funcs.has("貞")) throw new Error("语义：缺少入口函数「貞」（相当于 main）");
  let decls = 0;
  let loopDepth = 0;

  function walkExpr(e, scope) {
    if (!e) return;
    if (e.t === "num" || e.t === "str") return;
    if (e.t === "id") {
      const k = scope.get(e.v);
      if (!k) throw new Error(`语义：未声明的变量「${e.v}」`);
      if (k === "arr") throw new Error(`语义：数组「${e.v}」必须带下标使用`);
      return;
    }
    if (e.t === "index") {
      const k = scope.get(e.name);
      if (!k) throw new Error(`语义：未声明的数组「${e.name}」`);
      if (k !== "arr") throw new Error(`语义：「${e.name}」不是数组`);
      walkExpr(e.idx, scope);
      return;
    }
    if (e.t === "bin") { walkExpr(e.a, scope); walkExpr(e.b, scope); return; }
    if (e.t === "un") { walkExpr(e.a, scope); return; }
    if (e.t === "call") {
      if (e.callee.t !== "id") throw new Error("语义：只能调用具名函数");
      const f = funcs.get(e.callee.v);
      const b = BUILTINS[e.callee.v];
      if (f) {
        if (e.args.length !== f.params.length) throw new Error(`语义：函数「${f.name}」需要 ${f.params.length} 个参数，给了 ${e.args.length} 个`);
      } else if (b) {
        if (e.args.length !== b.argc) throw new Error(`语义：内建「${e.callee.v}」需要 ${b.argc} 个参数，给了 ${e.args.length} 个`);
      } else throw new Error(`语义：未定义的函数「${e.callee.v}」`);
      for (const a of e.args) walkExpr(a, scope);
      return;
    }
    throw new Error(`语义：未知表达式 ${e.t}`);
  }

  function walkScope(body, scope, fn) {
    for (const s of body) {
      if (s.t === "decl") {
        if (scope.has(s.name)) throw new Error(`语义：变量重复声明「${s.name}」`);
        scope.set(s.name, "int");
        if (s.init) walkExpr(s.init, scope);
        decls++;
      } else if (s.t === "arrdecl") {
        if (scope.has(s.name)) throw new Error(`语义：变量重复声明「${s.name}」`);
        walkExpr(s.size, scope);
        scope.set(s.name, "arr");
        decls++;
      } else if (s.t === "assign") {
        const t = s.target;
        if (t.t === "id") {
          const k = scope.get(t.v);
          if (!k) throw new Error(`语义：未声明的变量「${t.v}」`);
          if (k === "arr") throw new Error(`语义：不能整体赋值数组「${t.v}」`);
          if (s.op !== "=") throw new Error("语义：暂不支持复合赋值（用 名 = 名 + 值）");
        } else {
          const k = scope.get(t.name);
          if (!k) throw new Error(`语义：未声明的数组「${t.name}」`);
          if (k !== "arr") throw new Error(`语义：「${t.name}」不是数组`);
          if (s.op !== "=") throw new Error("语义：数组成员不支持 += / -=（用 名[下标] = 值）");
          walkExpr(t.idx, scope);
        }
        walkExpr(s.value, scope);
      } else if (s.t === "print" || s.t === "assert") {
        for (const a of s.args) walkExpr(a, scope);
      } else if (s.t === "exprst") {
        walkExpr(s.e, scope);
      } else if (s.t === "if") {
        walkExpr(s.c, scope);
        walkScope(s.then.body, new Map(scope), fn);
        if (s.els) walkScope(s.els.body, new Map(scope), fn);
      } else if (s.t === "while") {
        walkExpr(s.c, scope);
        loopDepth++;
        walkScope(s.body.body, new Map(scope), fn);
        loopDepth--;
      } else if (s.t === "for") {
        const inner = new Map(scope);
        if (s.init) {
          if (s.init.t === "decl") {
            if (inner.has(s.init.name)) throw new Error(`语义：变量重复声明「${s.init.name}」`);
            inner.set(s.init.name, "int");
            if (s.init.init) walkExpr(s.init.init, inner);
          } else walkExpr(s.init.e, inner);
        }
        if (s.cond) walkExpr(s.cond, inner);
        if (s.step) {
          if (s.step.t === "assignstep") {
            const k = inner.get(s.step.name);
            if (!k) throw new Error(`语义：未声明的变量「${s.step.name}」`);
            if (k === "arr") throw new Error(`语义：不能整体赋值数组「${s.step.name}」`);
            walkExpr(s.step.value, new Map(inner));
          } else walkExpr(s.step, new Map(inner));
        }
        loopDepth++;
        walkScope(s.body.body, inner, fn);
        loopDepth--;
      } else if (s.t === "break") {
        if (loopDepth === 0) throw new Error("语义：止（break）只能写在循环里");
      } else if (s.t === "continue") {
        if (loopDepth === 0) throw new Error("语义：续（continue）只能写在循环里");
      } else if (s.t === "ret") {
        if (fn.ret === "void" && s.e) throw new Error(`语义：无返回值函数「${fn.name}」不能 歸 值`);
        if (s.e) walkExpr(s.e, scope);
      }
    }
  }

  for (const f of ast.funcs) {
    const scope = new Map();
    for (const x of f.params) {
      if (scope.has(x.name)) throw new Error(`语义：参数重名「${x.name}」`);
      scope.set(x.name, "int");
    }
    walkScope(f.body.body, scope, f);
  }
  return { funcs, decls };
}

/* ---------------------------- 字节码 ---------------------------- */
const OP = {
  PUSH: 0x01, PUSHS: 0x02, LOAD: 0x03, STORE: 0x04, POP: 0x05,
  NEWARR: 0x06, LOADIDX: 0x07, STOREIDX: 0x08,
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
    if (e.t === "num") return emit(ch, OP.PUSH, e.v);
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
      if (s.t === "decl") {
        const slot = slotCount++;
        scope.set(s.name, slot);
        if (s.init) { expr(ch, s.init, scope); emit(ch, OP.STORE, slot); }
        else { emit(ch, OP.PUSH, 0); emit(ch, OP.STORE, slot); }
      } else if (s.t === "arrdecl") {
        const slot = slotCount++;
        scope.set(s.name, slot);
        expr(ch, s.size, scope);
        emit(ch, OP.NEWARR, null);
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
    const ch = { name: f.name, code: [], params: f.params.length };
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

  const printv = (v) => (typeof v === "string" ? v : String(v));
  const writeOut = (s) => { try { if (!silent) process.stdout.write(s); } catch (e) {} };

  function num(v, what) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("运行：" + what + " 需要整数，得到 " + printv(v));
    return Math.trunc(v);
  }

  async function runFn(chunk, args) {
    if (++depth > MAX_DEPTH) throw new Error("运行：调用层级过深（可能递归无终止）");
    const frame = { locals: new Array(chunk.nlocals).fill(0) };
    for (let i = 0; i < args.length && i < chunk.params; i++) frame.locals[i] = args[i];
    let pc = 0;
    try {
      for (;;) {
        if (++steps > MAX_STEPS) throw new Error("运行：指令数超限（可能死循环）");
        const ins = chunk.code[pc];
        if (!ins) throw new Error("运行：越过代码末尾");
        switch (ins.op) {
          case OP.PUSH: stack.push(ins.arg); pc++; break;
          case OP.PUSHS: stack.push(prog.strings[ins.arg]); pc++; break;
          case OP.LOAD: stack.push(frame.locals[ins.arg] ?? 0); pc++; break;
          case OP.STORE: frame.locals[ins.arg] = stack.pop(); pc++; break;
          case OP.POP: stack.pop(); pc++; break;
          case OP.NEWARR: {
            const n = num(stack.pop(), "数组长度");
            if (n < 0 || n > 1_000_000) throw new Error("运行：数组长度非法（" + n + "）");
            stack.push(new Array(n).fill(0));
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
          case OP.ADD: { const b = stack.pop(), a = stack.pop(); stack.push((a + b) | 0); pc++; break; }
          case OP.SUB: { const b = stack.pop(), a = stack.pop(); stack.push((a - b) | 0); pc++; break; }
          case OP.MUL: { const b = stack.pop(), a = stack.pop(); stack.push(Math.imul ? Math.imul(a, b) : a * b); pc++; break; }
          case OP.DIV: { const b = stack.pop(), a = stack.pop(); if (b === 0) throw new Error("运行：除以零"); stack.push(Math.trunc(a / b)); pc++; break; }
          case OP.MOD: { const b = stack.pop(), a = stack.pop(); if (b === 0) throw new Error("运行：除零取余"); stack.push(a % b); pc++; break; }
          case OP.NEG: stack.push(-stack.pop()); pc++; break;
          case OP.NOT: stack.push(stack.pop() ? 0 : 1); pc++; break;
          case OP.EQ: { const b = stack.pop(), a = stack.pop(); stack.push(a === b ? 1 : 0); pc++; break; }
          case OP.NE: { const b = stack.pop(), a = stack.pop(); stack.push(a !== b ? 1 : 0); pc++; break; }
          case OP.LT: { const b = stack.pop(), a = stack.pop(); stack.push(a < b ? 1 : 0); pc++; break; }
          case OP.LE: { const b = stack.pop(), a = stack.pop(); stack.push(a <= b ? 1 : 0); pc++; break; }
          case OP.GT: { const b = stack.pop(), a = stack.pop(); stack.push(a > b ? 1 : 0); pc++; break; }
          case OP.GE: { const b = stack.pop(), a = stack.pop(); stack.push(a >= b ? 1 : 0); pc++; break; }
          case OP.AND: { const b = stack.pop(), a = stack.pop(); stack.push(a && b ? 1 : 0); pc++; break; }
          case OP.OR: { const b = stack.pop(), a = stack.pop(); stack.push(a || b ? 1 : 0); pc++; break; }
          case OP.JMP: pc = ins.arg; break;
          case OP.JZ: pc = stack.pop() ? pc + 1 : ins.arg; break;
          case OP.JNZ: pc = stack.pop() ? ins.arg : pc + 1; break;
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
            const line = v ? "合" : "不合";
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

  async function callBuiltin(name, args) {
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
function buildProgram(src) {
  const srcLines = src.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("；"));
  const toks = lex(src);
  const ast = parse(toks);
  const sem = check(ast);
  const prog = compile(ast, sem.funcs);
  const jcb = listing(prog);
  return { srcLines, toks, ast, sem, prog, jcb };
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
        const built = buildProgram(src);
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
textarea{flex:1;min-height:180px;border:0;outline:none;resize:none;padding:10px 12px;background:transparent;color:#2b2118;font:13.5px/1.75 ui-monospace,Consolas,"Courier New",monospace;tab-size:4}
.row{display:flex;gap:8px;padding:8px 10px;border-top:1px solid rgba(120,96,64,.18);align-items:center}
.row label{font-size:11px;color:var(--brown)}
.row input{flex:1;border:1px solid rgba(120,96,64,.3);border-radius:6px;padding:5px 8px;font:12px ui-monospace,monospace;background:#fffaf0;color:var(--ink);outline:none}
.tabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid rgba(120,96,64,.18)}
.tab{font-size:11px;padding:4px 10px;border-radius:7px 7px 0 0;border:1px solid transparent;cursor:pointer;color:#7a6648}
.tab.on{background:#241d14;color:#e9e0cc;border-color:#241d14}
pre{flex:1;min-height:120px;margin:0;padding:10px 12px;overflow:auto;font:12px/1.65 ui-monospace,Consolas,monospace;background:#241d14;color:#e8e0cc;white-space:pre-wrap}
.stats{padding:6px 10px;font-size:11px;color:var(--brown);border-bottom:1px solid rgba(120,96,64,.18);min-height:26px}
.err{color:#b23a2a}
.ok{color:#2f6b47}
.oracle{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:row-reverse;gap:9px;align-items:flex-start;background:radial-gradient(120% 60% at 40% 10%,#fdf8ea,#f0e3ca 60%,#e4d0ac);border-radius:0 0 12px 12px}
.vcol{display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0}
.vcol .zi{font-family:"Oracular",ui-serif,serif;font-size:23px;line-height:1.12;color:#2e1f0e;text-shadow:0 1px 0 rgba(255,252,240,.7)}
.vcol .mk{width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#4a3622;font:15px ui-monospace,monospace}
.vcol .gap{height:8px}
#pngWrap{flex:1;display:none;align-items:center;justify-content:center;background:#1c1710;overflow:auto}
#png{max-width:100%;max-height:100%;object-fit:contain}
.hint{font-size:11px;color:#9d8a6d;padding:8px 12px}
kbd{border:1px solid rgba(180,150,110,.3);border-radius:4px;padding:0 4px;font-size:10px}
footer{padding:6px 16px 10px;font-size:11px;color:#8d7a5c}
</style></head><body>
<header>
  <div class="brand">甲 骨 <b>C++</b> · GUI</div>
  <div class="sub">本地编译器服务 · v${version}</div>
  <div class="chips"><span class="chip" id="chipState">就绪</span><span class="chip">隹 / 益 / 去 / 乘 / 分</span><span class="chip">止 / 续</span></div>
</header>
<main>
  <section class="panel">
    <h2>源码 <span class="mini">Ctrl+Enter 运行 · Ctrl+G 出图</span></h2>
    <div class="toolbar">
      <select id="examples"><option value="">— 载入示例 —</option></select>
      <button id="btnRun" class="primary">运行</button>
      <button id="btnCheck">检查</button>
      <button id="btnPng" class="gen">生成甲骨图</button>
      <button id="btnClear">清空</button>
    </div>
    <div class="row"><label>输入（给 听 用）</label><input id="stdin" placeholder="如 dddddq（贪吃蛇按键）"></div>
    <textarea id="src" spellcheck="false"></textarea>
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
    <div id="pngWrap"><img id="png" alt="甲骨程序图"><a id="dl" download="jiagu.png" style="position:absolute;margin:10px;color:#d8b26a;font-size:12px">下载 PNG</a></div>
  </section>
</main>
<footer>本地服务 · 仅监听 127.0.0.1 · 自动出图需要本机 Edge/Chrome</footer>
<script>
var FONT = new Set(Array.from(${JSON.stringify(fontChars)}));
var els = function(id){ return document.getElementById(id); };
var srcEl = els("src"), outEl = els("out"), jcbEl = els("jcb"), oracleEl = els("oracle"), lineEl = els("line"), statsEl = els("stats"), chip = els("chipState");
var pngWrap = els("pngWrap"), pngEl = els("png"), dlEl = els("dl");
function setChip(t, ok){ chip.textContent = t; chip.style.background = ok ? "rgba(47,93,67,.55)" : "rgba(138,43,26,.5)"; }
function esc(s){ return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function markFor(ch){ return '<span class="mk">' + esc(ch === " " ? "·" : ch) + '</span>'; }
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
document.querySelectorAll("[data-tab]").forEach(function(){}); 
els("btnRun").onclick = doRun; els("btnCheck").onclick = doCheck; els("btnPng").onclick = doPng;
els("btnClear").onclick = function(){ srcEl.value = ""; renderOracle(""); };
srcEl.addEventListener("input", function(){ renderOracle(srcEl.value); });
srcEl.addEventListener("keydown", function(e){
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
        if (d.ok) { srcEl.value = d.source; renderOracle(d.source); setChip("已载入 " + d.name, true); }
      });
    };
  });
}
loadExamples();
fetch("/api/default").then(function(r){ return r.json(); }).then(function(d){ if (d.ok) { srcEl.value = d.source; renderOracle(d.source); } });
</script></body></html>`;

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
    const built = buildProgram(src);
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
      if (req.method === "POST" && (url.pathname === "/api/run" || url.pathname === "/api/check" || url.pathname === "/api/png")) {
        const body = JSON.parse((await readBody(req)) || "{}");
        const src = String(body.src || "");
        if (url.pathname === "/api/check") {
          try {
            const built = buildProgram(src);
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
      const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["open", [url]];
      const child = spawnSync(opener[0], opener[1], { stdio: "ignore", timeout: 5000 });
      if (child.error) console.log("  请手动打开：" + url);
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
  console.log("    jcp gui [--port 7801]     打开图形界面（本地 Web GUI，默认自动开浏览器）");
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

    const built = buildProgram(src);
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
