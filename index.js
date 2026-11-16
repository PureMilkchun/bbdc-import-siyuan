"use strict";

const { Plugin, showMessage } = require("siyuan");
const { randomUUID } = require("node:crypto");
const ORIGIN = "https://bbdc.cn";
const DICTIONARY = "https://langeasy.com.cn";
const PARTITION = "persist:bbdc-import-siyuan";
const BATCH_SIZE = 20;
// A simplified version of the plugin icon, sized for SiYuan's monochrome toolbar.
const TOOLBAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 19c-1.2-1.4-3-2-5-2H3.5V5.5H7c2 0 3.8.6 5 2 1.2-1.4 3-2 5-2h3.5V13"/>
    <path d="M12 7.5V19M6.2 9h3M6.2 12h3M14.8 9h3"/>
    <circle cx="18.5" cy="17.5" r="3.8"/>
    <path d="M18.5 15.7v3.6M16.7 17.5h3.6"/>
</svg>`;
const TERM = /^[a-z]+(?:[-' ][a-z]+)*$/;
const LOGIN_ERRORS = new Set(["请登录", "请先登录", "未登录", "请重新登录", "登录已过期"]);
const LOGIN_NAVIGATION = new Set([ORIGIN, "https://open.weixin.qq.com"]);
const TIPS = {
    login_required: "点击思源顶部的「不背单词 · 登录」，在独立窗口登录后重试。",
    access_denied: "不背单词拒绝了访问，请先在登录窗口检查账号和网络。",
    rate_limited: "服务暂时限流，请稍后重试，不要连续发起推送。",
    write_unconfirmed: "当前词可能已经写入。稍后用「核对」查询，暂时不要重复推送。",
    invalid_response: "服务返回了无法识别的数据，已停止，未尝试的词可稍后重试。",
    network_error: "请求没有完成，检查网络后再试。",
    wordbook_changed: "读取时生词本发生变化，已停止。请稍后重新核对。",
    wordbook_timeout: "读取生词本耗时较长，已停止。请稍后重新核对。",
    more_remaining: "本次运行时间已到。需要继续时，用返回的剩余词表再推一批。",
    cancelled: "已取消推送。",
    busy: "另一个不背单词任务正在运行，请等它结束。",
    login_window_open: "请先完成登录并关闭登录窗口，再回到 Agent 继续。",
};

class BbdcError extends Error {
    constructor(code) { super(code); this.code = code; }
}

function normalize(words) {
    if (!Array.isArray(words) || !words.length || words.length > BATCH_SIZE) {
        throw new Error(`每次请提交 1–${BATCH_SIZE} 个词；更长的词表请分批。`);
    }
    const items = words.map((word, index) => {
        if (typeof word !== "string" || word.length > 250) throw new Error(`第 ${index + 1} 项不是有效词条。`);
        const term = word.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[‐‑]/g, "-").replace(/\s+/g, " ");
        if (term.length > 120 || !TERM.test(term)) throw new Error(`第 ${index + 1} 项应为一个英文词或短语。`);
        return term;
    });
    const terms = [...new Set(items)];
    return { terms, duplicates: items.length - terms.length };
}

// Electron owns the HttpOnly cookies in a separate browser partition.
// Dictionary traffic never includes session credentials.
async function requestJSON(remote, url, { account = true, body, timeoutMs = 7000 } = {}) {
    const options = {
        credentials: account ? "include" : "omit", cache: "no-store", redirect: "error",
        bypassCustomProtocolHandlers: true,
    };
    if (body !== undefined) {
        const boundary = "bbdc-" + randomUUID();
        options.method = "POST";
        options.headers = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
        options.body = `--${boundary}\r\nContent-Disposition: form-data; name="newwordlist"\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}--\r\n`;
    }
    try {
        // Create the signal in Electron's main process, where the session runs.
        options.signal = remote.getGlobal("AbortSignal").timeout(timeoutMs);
        const response = await remote.session.fromPartition(PARTITION).fetch(url, options);
        const text = await response.text();
        let data;
        if (text.length <= 512 * 1024) {
            try { data = JSON.parse(text); } catch { /* Status still matters. */ }
        }
        return { status: response.status, data };
    } catch {
        throw new BbdcError("network_error");
    }
}

function businessCode(data) {
    return data?.result_code ?? data?.resultCode;
}

function validate({ status, data }, account = true) {
    const code = businessCode(data);
    const loginError = [data?.error_body?.user_message, data?.error_body?.info].some(
        text => typeof text === "string" && LOGIN_ERRORS.has(text.trim().replace(/[。！!.]+$/, "")),
    );
    if (account && (status === 401 || code === 401 || loginError)) throw new BbdcError("login_required");
    if (status === 429 || code === 429) throw new BbdcError("rate_limited");
    if (status === 403 || code === 403) throw new BbdcError("access_denied");
    if (status >= 500 || status === 408) throw new BbdcError("network_error");
    if (status < 200 || status >= 300 || !data || typeof data !== "object" || Array.isArray(data)) {
        throw new BbdcError("invalid_response");
    }
    return data;
}

function createClient(request) {
    async function read(url, account = true) {
        for (let attempt = 0; ; attempt++) {
            try {
                return validate(await request(url, { account }), account);
            } catch (error) {
                if (attempt || error.code !== "network_error") throw error;
                await new Promise(resolve => setTimeout(resolve, 600));
            }
        }
    }
    return {
        async login() {
            const data = await read(ORIGIN + "/api/check-login");
            if (businessCode(data) !== 200) throw new BbdcError("invalid_response");
        },
        async wordbook(deadline = Infinity) {
            const loadPage = async page => {
                const data = await read(ORIGIN + "/api/user-new-word?" + new URLSearchParams({ page: String(page) }));
                const body = data.data_body;
                const info = body?.pageInfo;
                const records = body?.wordList;
                if (businessCode(data) !== 200 || !Array.isArray(records) || !info
                    || !Number.isSafeInteger(info.totalRecord) || info.totalRecord < 0
                    || !Number.isSafeInteger(info.pageSize) || info.pageSize <= 0
                    || !Number.isSafeInteger(info.totalPage) || info.totalPage < 0 || info.totalPage > 5000
                    || info.currentPage !== page + 1
                    || records.some(item => !item || typeof item.word !== "string" || !item.word.trim())) {
                    throw new BbdcError("invalid_response");
                }
                return { info, records };
            };
            const first = await loadPage(0);
            const { totalRecord, pageSize, totalPage } = first.info;
            if ((totalRecord === 0 && (first.records.length !== 0 || totalPage > 1))
                || (totalRecord > 0 && totalPage !== Math.ceil(totalRecord / pageSize))) {
                throw new BbdcError("invalid_response");
            }
            const pages = [first];
            for (let start = 1; start < totalPage; start += 3) {
                if (Date.now() >= deadline) throw new BbdcError("wordbook_timeout");
                const batch = Array.from({ length: Math.min(3, totalPage - start) }, (_, i) => start + i);
                pages.push(...await Promise.all(batch.map(loadPage)));
            }
            let count = 0;
            const words = new Set();
            for (const [index, page] of pages.entries()) {
                if (page.info.totalRecord !== totalRecord || page.info.pageSize !== pageSize
                    || page.info.totalPage !== totalPage
                    || page.records.length !== Math.min(pageSize, Math.max(0, totalRecord - index * pageSize))) {
                    throw new BbdcError("wordbook_changed");
                }
                count += page.records.length;
                for (const item of page.records) words.add(item.word.trim().toLowerCase());
            }
            if (count !== totalRecord) throw new BbdcError("wordbook_changed");
            return words;
        },
        async definition(word) {
            const url = DICTIONARY + "/loadLexisList.action?" + new URLSearchParams({ strict: "1", word });
            const data = await read(url, false);
            if (!Array.isArray(data.wordlist)) throw new BbdcError("invalid_response");
            if (!data.wordlist.length) return "";
            if (typeof data.wordlist[0]?.interpret !== "string") throw new BbdcError("invalid_response");
            return data.wordlist[0].interpret.trim();
        },
        async add(word, info) {
            const body = { word, info, course: "*", wordidx: "*", infoidx: "100", selection: "*", opcode: "1" };
            try {
                const data = validate(await request(ORIGIN + "/api/user-new-word", { body }));
                if (businessCode(data) !== 200) throw new BbdcError("write_unconfirmed");
            } catch (e) {
                if (["login_required", "rate_limited", "access_denied"].includes(e.code)) throw e;
                throw new BbdcError("write_unconfirmed");
            }
        },
    };
}

async function execute(client, action, terms, confirm, { limitMs = 22000, gapMs = 400, inactive = () => false } = {}) {
    const report = { action, added: [], existing: [], missing: [], without_definition: [], uncertain: [], remaining: [...terms] };
    const stop = code => ({ ...report, status: code, hint: TIPS[code] ?? TIPS.network_error });
    try {
        await client.login();
        if (inactive() || (action === "push" && !await confirm(terms))) return stop("cancelled");
    } catch (e) { return stop(e.code ?? "network_error"); }
    const deadline = Date.now() + limitMs;
    let existing;
    try { existing = await client.wordbook(deadline); }
    catch (e) { return stop(e.code ?? "network_error"); }
    for (const word of terms) {
        if (inactive()) return stop("cancelled");
        if (Date.now() >= deadline) return stop("more_remaining");
        try {
            if (existing.has(word)) report.existing.push(word);
            else if (action === "check") report.missing.push(word);
            else {
                if (Date.now() >= deadline) return stop("more_remaining");
                const info = await client.definition(word);
                if (inactive()) return stop("cancelled");
                if (Date.now() >= deadline) return stop("more_remaining");
                await client.add(word, info);
                report.added.push(word);
                existing.add(word);
                if (!info) report.without_definition.push(word);
            }
            report.remaining.shift();
        } catch (e) {
            if (e.code === "write_unconfirmed") {
                report.uncertain.push(word);
                report.remaining.shift();
            }
            return stop(e.code ?? "network_error");
        }
        if (report.remaining.length && gapMs) await new Promise(resolve => setTimeout(resolve, gapMs));
    }
    return { ...report, status: "completed" };
}

function openLogin(remote, onClose) {
    const session = remote.session.fromPartition(PARTITION);
    // A separate, sandboxed web window: do not load the site into SiYuan's privileged renderer.
    const window = new remote.BrowserWindow({
        width: 980, height: 760, autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION, sandbox: true, contextIsolation: true, webSecurity: true,
            nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
            webviewTag: false, allowRunningInsecureContent: false,
        },
    });
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        if (details.resourceType !== "mainFrame") { callback({}); return; }
        try {
            const url = new URL(details.url);
            callback({ cancel: !LOGIN_NAVIGATION.has(url.origin) });
        } catch { callback({ cancel: true }); }
    });
    // Prevent saving files from this login-only session.
    const download = (_event, item) => { try { item.cancel(); } catch { /* Already cancelled. */ } };
    session.on("will-download", download);
    window.on("closed", () => {
        session.webRequest.onBeforeRequest(null);
        session.removeListener("will-download", download);
        onClose();
    });
    window.loadURL(ORIGIN + "/index").catch(() => {
        if (!window.isDestroyed()) showMessage("无法打开不背单词登录页，请检查网络。", 5000, "error");
    });
    return window;
}

const packageResult = data => ({ result: JSON.stringify(data), structuredContent: data });

module.exports = class BbdcPlugin extends Plugin {
    onload() {
        this.inactive = false;
        let remote;
        try { remote = require("@electron/remote"); } catch { return; }
        if (typeof this.addAgentCapability !== "function" || !remote.session || !remote.BrowserWindow) return;
        const client = createClient((url, options) => requestJSON(remote, url, options));
        this.addTopBar({
            id: "bbdc-login", icon: TOOLBAR_ICON, position: "right", title: "不背单词 · 登录",
            callback: () => {
                try {
                    if (this.busy) { showMessage(TIPS.busy); return; }
                    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.focus();
                    else this.loginWindow = openLogin(remote, () => { this.loginWindow = null; });
                } catch { showMessage("无法打开登录窗口，请在思源桌面版重试。", 5000, "error"); }
            },
        });
        this.addAgentCapability({
            name: "bbdc_wordbook", title: "不背单词生词本",
            description: "管理不背单词的「我的生词本」：preview 只离线去重；check 核对词是否已存在；push 仅在用户明确要求上传时使用，上传前会弹出确认。只传用户选定的词，不传整篇笔记。不需要 Python 或终端。先在顶部「不背单词 · 登录」手动登录。一次最多 20 个词；不要自动重推 uncertain 里的词。",
            inputSchema: {
                type: "object", additionalProperties: false, required: ["action", "words"],
                properties: {
                    action: { type: "string", enum: ["preview", "check", "push"] },
                    words: { type: "array", minItems: 1, maxItems: BATCH_SIZE, items: { type: "string", maxLength: 250 } },
                },
            },
            actionEffects: { preview: {}, check: { dataEgress: true }, push: { dataEgress: true } },
            handler: async args => {
                if (!args || !["preview", "check", "push"].includes(args.action)) return { error: "请选择 preview、check 或 push。" };
                let batch;
                try { batch = normalize(args.words); } catch (error) { return { error: error.message }; }
                if (args.action === "preview") return packageResult({ status: "prepared", ...batch });
                if (this.busy) return packageResult({ status: "busy", hint: TIPS.busy });
                if (this.loginWindow && !this.loginWindow.isDestroyed()) {
                    return packageResult({ status: "login_window_open", hint: TIPS.login_window_open });
                }
                this.busy = true;
                try {
                    const result = await execute(client, args.action, batch.terms, async terms => {
                        const { response } = await remote.dialog.showMessageBox(remote.getCurrentWindow(), {
                            type: "question", title: "不背单词", message: `将 ${terms.length} 个词加入「我的生词本」？`,
                            detail: terms.join("\n"), buttons: ["取消", "加入生词本"], defaultId: 0, cancelId: 0,
                        });
                        return response === 1;
                    }, { inactive: () => this.inactive });
                    return packageResult({ ...result, duplicates: batch.duplicates });
                } finally { this.busy = false; }
            },
        });
    }
    onunload() {
        this.inactive = true;
        if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close();
    }
};

module.exports.test = { normalize, createClient, execute, requestJSON, openLogin, PARTITION };
