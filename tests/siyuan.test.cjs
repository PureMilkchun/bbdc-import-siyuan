"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pluginPath = path.resolve(__dirname, "../index.js");
function load(remote) {
    const wrapper = new Function("require", "module", fs.readFileSync(pluginPath, "utf8"));
    const mod = { exports: {} };
    wrapper(name => {
        if (name === "siyuan") return {
            showMessage() {},
            Plugin: class { addTopBar(registration) { this.topBar = registration; } addAgentCapability(registration) { this.capability = registration; } },
        };
        if (name === "@electron/remote") return remote;
        return require(name);
    }, mod);
    return mod.exports;
}

test("use the native Agent tool and require a visible confirmation before any write", async () => {
    let calls = 0;
    let confirmation;
    const remote = {
        BrowserWindow: class {},
        session: { fromPartition: () => ({
            async fetch() {
                calls++;
                return { status: 200, text: async () => '{"result_code":200}' };
            },
        }) },
        getGlobal: () => AbortSignal,
        getCurrentWindow: () => ({}),
        dialog: { showMessageBox: async (_, opts) => { confirmation = opts; return { response: 0 }; } },
    };
    const plugin = new (load(remote))();
    plugin.onload();
    assert.equal(plugin.capability.name, "bbdc_wordbook");
    assert.match(plugin.topBar.icon, /^<svg/);
    assert.match(plugin.topBar.icon, /currentColor/);
    assert.equal(plugin.topBar.title, "不背单词 · 登录");
    const preview = await plugin.capability.handler({ action: "preview", words: [" Resilient", "resilient", "coach’s"] });
    assert.deepEqual(preview.structuredContent.terms, ["resilient", "coach's"]);
    assert.equal(calls, 0);
    assert.match((await plugin.capability.handler({ action: "push", words: ["bad!"] })).error, /第 1 项/);
    assert.equal(calls, 0);
    const cancelled = await plugin.capability.handler({ action: "push", words: ["Resilient"] });
    assert.equal(cancelled.structuredContent.status, "cancelled");
    assert.equal(confirmation.detail, "resilient");
    assert.equal(confirmation.defaultId, 0);
    assert.equal(calls, 1); // Only check-login, no word lookup or write.
});

test("check-only does not request definitions or add; push reports a lost write separately", async () => {
    const { createClient, execute } = load().test;
    const actions = [];
    const client = createClient(async (raw, options) => {
        const url = new URL(raw);
        const word = url.searchParams.get("word");
        actions.push([url.pathname, word, options]);
        if (url.pathname === "/api/check-login") return { status: 200, data: { result_code: 200 } };
        if (url.pathname === "/api/user-new-word" && !options?.body) {
            return { status: 200, data: { result_code: 200, data_body: {
                wordList: [{ word: "already" }],
                pageInfo: { totalRecord: 1, pageSize: 24, totalPage: 1, currentPage: 1 },
            } } };
        }
        if (url.pathname === "/loadLexisList.action") {
            assert.equal(options.account, false);
            return { status: 200, data: { wordlist: [] } };
        }
        if (url.pathname === "/api/user-new-word") {
            assert.deepEqual(options.body, {
                word: options.body.word, info: "", course: "*", wordidx: "*", infoidx: "100", selection: "*", opcode: "1",
            });
            if (options.body.word === "unclear") return { status: 502 };
            return { status: 200, data: { result_code: 200 } };
        }
        assert.fail(url.pathname);
    });
    const check = await execute(client, "check", ["already", "not yet"], () => assert.fail("no confirmation"), { gapMs: 0 });
    assert.deepEqual(check.existing, ["already"]);
    assert.deepEqual(check.missing, ["not yet"]);
    assert.equal(actions.length, 2);
    actions.length = 0;
    const push = await execute(client, "push", ["already", "fresh", "unclear", "later"], async () => true, { gapMs: 0 });
    assert.equal(push.status, "write_unconfirmed");
    assert.deepEqual(push.added, ["fresh"]);
    assert.deepEqual(push.without_definition, ["fresh"]);
    assert.deepEqual(push.uncertain, ["unclear"]);
    assert.deepEqual(push.remaining, ["later"]);
    assert.equal(actions.filter(a => a[0] === "/api/user-new-word" && a[2]?.body).length, 2);
});

test("HTTP 200 logged-out response and HTTP 429 stop the batch before further requests", async () => {
    const { createClient, execute } = load().test;
    for (const [response, status] of [
        [{ status: 200, data: { result_code: 20000, error_body: { user_message: "请登录" } } }, "login_required"],
        [{ status: 429 }, "rate_limited"],
    ]) {
        let calls = 0;
        const client = createClient(async () => { calls++; return response; });
        const result = await execute(client, "push", ["fresh"], () => assert.fail("not ready"));
        assert.equal(result.status, status);
        assert.deepEqual(result.remaining, ["fresh"]);
        assert.equal(calls, 1);
    }
});

test("an incomplete wordbook response never triggers an add", async () => {
    const { createClient, execute } = load().test;
    const calls = [];
    const client = createClient(async raw => {
        const route = new URL(raw).pathname;
        calls.push(route);
        if (route === "/api/check-login") return { status: 200, data: { result_code: 200 } };
        if (route === "/api/user-new-word") return { status: 200, data: { result_code: 200, data_body: {} } };
        assert.fail("Unexpected request " + route);
    });
    const result = await execute(client, "push", ["vivid"], async () => true, { gapMs: 0 });
    assert.equal(result.status, "invalid_response");
    assert.deepEqual(result.remaining, ["vivid"]);
    assert.deepEqual(calls, ["/api/check-login", "/api/user-new-word"]);
});

test("reads every wordbook page and stops if pagination changes", async () => {
    const { createClient, execute } = load().test;
    let inconsistent = false;
    let posts = 0;
    const client = createClient(async (raw, options) => {
        const url = new URL(raw);
        if (url.pathname === "/api/check-login") return { status: 200, data: { result_code: 200 } };
        if (options?.body) { posts++; assert.fail("unexpected write"); }
        const page = Number(url.searchParams.get("page"));
        const records = [[{ word: "vivid" }, { word: "relief" }], [{ word: "postoperative" }]][page];
        return { status: 200, data: { result_code: 200, data_body: {
            wordList: records,
            pageInfo: { totalRecord: inconsistent && page === 1 ? 4 : 3, pageSize: 2, totalPage: 2, currentPage: page + 1 },
        } } };
    });
    const terms = ["vivid", "postoperative", "not-there"];
    const result = await execute(client, "check", terms, async () => true, { gapMs: 0 });
    assert.deepEqual(result.existing, ["vivid", "postoperative"]);
    assert.deepEqual(result.missing, ["not-there"]);
    inconsistent = true;
    const stopped = await execute(client, "push", terms, async () => true, { gapMs: 0 });
    assert.equal(stopped.status, "wordbook_changed");
    assert.deepEqual(stopped.remaining, terms);
    assert.equal(posts, 0);
});

test("a transient list failure is retried and 12 pages are checked before results", async () => {
    const { createClient, execute } = load().test;
    const counts = new Map();
    const client = createClient(async raw => {
        const url = new URL(raw);
        if (url.pathname === "/api/check-login") return { status: 200, data: { result_code: 200 } };
        const page = Number(url.searchParams.get("page"));
        counts.set(page, (counts.get(page) || 0) + 1);
        if (page === 3 && counts.get(page) === 1) throw Object.assign(new Error("temporary"), { code: "network_error" });
        const length = Math.min(24, 274 - page * 24);
        const words = Array.from({ length }, (_, i) => ({ word: `term${page}-${i}` }));
        if (page === 6) words[0] = { word: "vivid" };
        if (page === 0) words[0] = { word: "postoperative" };
        return { status: 200, data: { result_code: 200, data_body: {
            wordList: words, pageInfo: { totalRecord: 274, pageSize: 24, totalPage: 12, currentPage: page + 1 },
        } } };
    });
    const result = await execute(client, "check", ["vivid", "postoperative", "not-there"], () => {}, { gapMs: 0 });
    assert.deepEqual(result.existing, ["vivid", "postoperative"]);
    assert.deepEqual(result.missing, ["not-there"]);
    assert.equal(counts.size, 12);
    assert.equal(counts.get(3), 2);
});
