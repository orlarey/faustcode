// Builds webapp/faust-doc-index.json, the index of the documentation of the Faust libraries used by
// the completion and the library tools (webapp/faust-doc.js, MCP search_faust_lib, get_faust_symbol...),
// from the libraries that faustcode embeds (webapp/libfaust-wasm), so that both stay the same.
//
//     node scripts/build-doc-index.mjs                 libraries of webapp/libfaust-wasm
//     node scripts/build-doc-index.mjs --libs <dir>    libraries of a directory of .lib files
//     node scripts/build-doc-index.mjs --check         fails if the index is not up to date
//
// The documentation follows the conventions of the Faust libraries (faust2md):
//
//     //-------`(fi.)lowpass`----------
//     // Summary, on one or several paragraphs.
//     //
//     // #### Usage
//     //
//     // ```
//     // _ : lowpass(N,fc) : _
//     // ```
//     //
//     // Where:
//     //
//     // * `N`: filter order (number of poles), nonnegative constant numerical expression
//     // * `fc`: frequency
//     //
//     // #### Test
//     // ```
//     // fi = library("filters.lib");
//     // lowpass_test = fi.lowpass(3, 1000);
//     // ```
//     //---------------------------------
//
// Libraries: stdfaust.lib, then the libraries it imports, in its order, with their environment
// ("fi" for filters.lib) as alias hint.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(root, "webapp/faust-doc-index.json");
const ROOT_LIB = "stdfaust.lib";
const LIB_DIR = "/usr/share/faust";

// The .lib files of the libfaust embedded in the webapp: name -> text.
async function embeddedLibraries() {
    const fw = await import(pathToFileURL(path.join(root, "webapp/faustwasm/index.js")).href);
    const dir = path.join(root, "webapp/libfaust-wasm");
    const module = await fw.instantiateFaustModuleFromFile(`${dir}/libfaust-wasm.js`, `${dir}/libfaust-wasm.data`, `${dir}/libfaust-wasm.wasm`);
    const lib = new fw.LibFaust(module);
    const fs = lib.fs();
    const files = new Map();
    for (const name of fs.readdir(LIB_DIR)) {
        if (name.endsWith(".lib")) files.set(name, fs.readFile(`${LIB_DIR}/${name}`, { encoding: "utf8" }));
    }
    return { files, version: lib.version() };
}

function directoryLibraries(dir) {
    const files = new Map();
    for (const name of readdirSync(dir)) if (name.endsWith(".lib")) files.set(name, readFileSync(path.join(dir, name), "utf8"));
    return { files, version: null };
}

// "xx = library("file.lib");" of stdfaust.lib, in order.
export function environments(stdfaust) {
    const list = [];
    for (const m of stdfaust.matchAll(/^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*library\(\s*"([^"]+\.lib)"\s*\)\s*;/gm)) list.push({ alias: m[1], file: m[2] });
    return list;
}

const HEADER = /^\/\/-{2,}\s*`(?:\(([A-Za-z_][A-Za-z_0-9]*)\.\))?([^`]+)`[-\s]*$/;
const CLOSING = /^\/\/-{3,}\s*$/;

const strip = (line) => line.replace(/^\/\/ ?/, "");

// Splits a usage line at its top-level ":" (not inside parentheses, not "<:" or ":>").
function topLevelSegments(usage) {
    const segments = [];
    let depth = 0, start = 0;
    for (let i = 0; i < usage.length; i++) {
        const c = usage[i];
        if (c == "(" || c == "[" || c == "{") depth++;
        else if (c == ")" || c == "]" || c == "}") depth--;
        else if (c == ":" && depth == 0 && usage[i - 1] != "<" && usage[i + 1] != ">") {
            segments.push(usage.slice(start, i).trim());
            start = i + 1;
        }
    }
    segments.push(usage.slice(start).trim());
    return segments;
}

// Number of signals of a side of a usage: "_" -> 1, "_,_" -> 2; null if it is not only wires.
function wires(segment) {
    if (segment === undefined) return null;
    const parts = segment.split(",").map((p) => p.trim());
    return parts.every((p) => p == "_") ? parts.length : null;
}

// Inputs and outputs read from the usage: "_ : lowpass(N,fc) : _" -> 1 and 1, "osc(freq) : _" -> 0 and 1.
export function signalsOf(usage, name) {
    if (!usage) return { inSignals: null, outSignals: null, raw: null };
    const segments = topLevelSegments(usage.replace(/\s*\/\/.*$/, ""));
    const at = segments.findIndex((s) => s == name || s.startsWith(name + "(") || s.startsWith(name + " "));
    if (at < 0) return { inSignals: null, outSignals: null, raw: usage };
    return { inSignals: at == 0 ? 0 : wires(segments[at - 1]), outSignals: wires(segments[at + 1]), raw: usage };
}

// The documented symbols of a library.
export function parseLibrary(file, text, alias) {
    const lines = text.split(/\r?\n/);
    const base = file.replace(/\.lib$/, "");
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
        const header = HEADER.exec(lines[i]);
        if (!header) continue;
        let end = i + 1;
        // up to the closing line, the next header or the code (blank lines may separate sections)
        while (end < lines.length && !CLOSING.test(lines[end]) && !HEADER.test(lines[end]) && (lines[end].startsWith("//") || !lines[end].trim())) end++;
        // a Test section written after the closing line (some functions of filters.lib)
        let close = end;
        if (end < lines.length && CLOSING.test(lines[end])) {
            let k = end + 1;
            while (k < lines.length && !HEADER.test(lines[k]) && (lines[k].startsWith("//") || !lines[k].trim())) k++;
            const after = lines.slice(end + 1, k);
            if (after.some((l) => /^\/\/\s*#{2,}\s*Test\b/i.test(l))) {
                close = k;
                while (close > end + 1 && !CLOSING.test(lines[close - 1]) && !lines[close - 1].trim()) close--;
            }
        }
        const body = [...lines.slice(i + 1, end), ...lines.slice(end + 1, close)].filter((l) => !CLOSING.test(l)).map(strip);
        const name = header[2].trim();
        const env = header[1] ?? alias;
        symbols.push({
            id: `${base}.${name}`,
            name,
            qualifiedName: env ? `${env}.${name}` : name,
            header: header[1] ? `(${header[1]}.)${name}` : name,
            ...describe(body, name),
            tags: [base],
            source: { file, lineStart: i + 1, lineEnd: close > end ? close : end < lines.length && CLOSING.test(lines[end]) ? end + 1 : end },
        });
        symbols[symbols.length - 1].io = signalsOf(symbols[symbols.length - 1].usage, name);
        i = Math.max(end, close) - 1;
    }
    // (a header written twice, copied and pasted in a library, gives two symbols of the same id, as
    // in the original index: both documentations are kept)
    // the io key in the place of the original index
    return symbols.map(({ id, name, qualifiedName, header, summary, usage, params, io, testCode, tags, source }) => ({ id, name, qualifiedName, header, summary, usage, params, io, testCode, tags, source }));
}

// Summary, usage, parameters and test of a documentation block (lines without "//").
function describe(body, name) {
    const section = (title) => body.findIndex((l) => new RegExp(`^#{2,}\\s*${title}\\b`, "i").test(l.trim()));
    // the end of a section: the next heading, or "Where:"
    const sectionEnd = (index) => {
        const next = body.findIndex((l, k) => k > index && (/^#{2,}\s/.test(l.trim()) || /^where\s*:/i.test(l.trim())));
        return next < 0 ? body.length : next;
    };
    // the first code block of a section
    const codeAfter = (index) => {
        if (index < 0) return null;
        const end = sectionEnd(index);
        const open = body.findIndex((l, k) => k > index && k < end && l.trim().startsWith("```"));
        if (open < 0) return null;
        const close = body.findIndex((l, k) => k > open && l.trim().startsWith("```"));
        return body.slice(open + 1, close < 0 ? body.length : close);
    };
    const usageIndex = section("Usage");
    const testIndex = section("Test");
    const firstSection = body.findIndex((l) => /^#{2,}\s/.test(l.trim()) || /^where\s*:/i.test(l.trim()));
    const summary = body.slice(0, firstSection < 0 ? body.length : firstSection).map((l) => l.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    // the usage: in its code block, the line naming the symbol with its inputs and outputs
    // ("_,_,_,_ : selector(2,4) : _"), else the first line naming it ("count(l)"), else the first line;
    // without a code block, the first line of the section ("* `if(cond, then, else) : _`" gives
    // "if(cond, then, else) : _")
    let usage = null;
    const code = codeAfter(usageIndex)?.map((l) => l.trim()).filter(Boolean) ?? [];
    if (code.length > 0) {
        const names = new RegExp(`(^|[^A-Za-z_0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z_0-9]|$)`);
        const naming = code.filter((l) => names.test(l));
        usage = naming.find((l) => /(^|[^<]):([^>]|$)/.test(l.replace(/\s*\/\/.*$/, ""))) ?? naming[0] ?? code[0];
    } else if (usageIndex >= 0) {
        const text = body.slice(usageIndex + 1, sectionEnd(usageIndex)).map((l) => l.trim()).find(Boolean);
        usage = text ? text.replace(/^[*-]\s+/, "").replace(/^`(.*)`$/, "$1") : null;
    }
    const test = codeAfter(testIndex);
    return {
        summary,
        usage,
        params: parameters(body),
        testCode: test && test.join("\n").trim() ? test.join("\n").replace(/\s+$/, "") : null,
    };
}

// "* `name`: description" after "Where:", continuation lines included.
function parameters(body) {
    const where = body.findIndex((l) => /^where\s*:/i.test(l.trim()));
    if (where < 0) return [];
    const params = [];
    for (let k = where + 1; k < body.length; k++) {
        const line = body[k];
        if (/^#{2,}\s/.test(line.trim())) break;
        const item = /^\s*[*-]\s+`?([A-Za-z_][A-Za-z_0-9]*(?:\s*\([^)]*\))?)`?\s*:\s*(.*)$/.exec(line);
        if (item) {
            params.push({ name: item[1].trim(), description: item[2].trim() });
        } else if (line.trim() && params.length && (/^\s+/.test(line) || /^\s*[*-]\s/.test(line))) {
            params[params.length - 1].description = `${params[params.length - 1].description} ${line.trim()}`.trim();
        } else if (line.trim() && params.length) {
            break;
        }
    }
    return params;
}

export function buildIndex(files, generatedAt = new Date().toISOString()) {
    const stdfaust = files.get(ROOT_LIB);
    if (stdfaust === undefined) throw new Error(`${ROOT_LIB} not found`);
    const libraries = [{ file: ROOT_LIB, aliasHints: [], symbols: [] }];
    const symbols = [];
    for (const { alias, file } of environments(stdfaust)) {
        const text = files.get(file);
        if (text === undefined || libraries.some((l) => l.file == file)) continue;
        const own = parseLibrary(file, text, alias);
        libraries.push({ file, aliasHints: [alias], symbols: own });
        symbols.push(...own);
    }
    return { version: 1, generatedAt, rootLib: ROOT_LIB, rootLibPath: `${LIB_DIR}/${ROOT_LIB}`, libraries, symbols };
}

// The index of the libraries embedded in the webapp.
export async function embeddedIndex() {
    const { files, version } = await embeddedLibraries();
    const index = buildIndex(files);
    index.libfaust = version;
    return index;
}

// The index without its date, to compare two builds.
const content = (index) => JSON.stringify({ ...index, generatedAt: undefined });

async function main() {
    const args = process.argv.slice(2);
    const at = args.indexOf("--libs");
    const { files, version } = at >= 0 ? directoryLibraries(args[at + 1]) : await embeddedLibraries();
    const index = buildIndex(files);
    if (version) index.libfaust = version;
    if (args.includes("--check")) {
        const current = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : null;
        if (!current || content(current) != content(index)) {
            console.error(`${OUTPUT} is not up to date: run node scripts/build-doc-index.mjs`);
            process.exit(1);
        }
        console.log(`${OUTPUT} is up to date`);
        return;
    }
    writeFileSync(OUTPUT, JSON.stringify(index) + "\n");
    console.log(`${OUTPUT}: ${index.libraries.length} libraries, ${index.symbols.length} symbols${version ? ` (libfaust ${version})` : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) == fileURLToPath(import.meta.url)) await main();
