import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createAppServer } from "./server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };
const draft = "Спасибо за обращение. Уточним детали заявки.";

async function startServer(options) {
  const server = createAppServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function post(app, body) {
  const reply = await fetch(`${app.url}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(2_000),
  });
  assert.match(reply.headers.get("content-type"), /application\/json/);
  return { status: reply.status, body: await reply.json() };
}

let app;
before(async () => { app = await startServer(); });
after(async () => { await app?.close(); });

test("invalid input returns 400 without calling the model", async (t) => {
  let calls = 0;
  const isolated = await startServer({ model: () => { calls++; } });
  t.after(isolated.close);
  const invalid = [
    "", "{", "null", "[]", '"hello"', "42", "true", "{}",
    ...["", " \n\t ", null, 42, false, [], {}].map((text) => JSON.stringify({ text })),
  ];
  for (const body of invalid) {
    await t.test(`body ${JSON.stringify(body)}`, async () => {
      assert.deepEqual(await post(isolated, body), {
        status: 400, body: { status: "invalid_input" },
      });
    });
  }
  assert.equal(calls, 0);
});

test("valid input returns the expected topic and draft", async (t) => {
  for (const [text, topic] of [
    ["  Когда доставка?  ", "delivery"],
    ["Какова стоимость?", "pricing"],
    ["Здравствуйте", "other"],
  ]) {
    await t.test(topic, async () => {
      assert.deepEqual(await post(app, JSON.stringify({ text })), {
        status: 200, body: { status: "ready", topic, draft },
      });
    });
  }
});

test("all mock failure scenarios return manual review and no draft", async (t) => {
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await t.test(marker, async () => {
      // A previous successful request must not leak into a failing result.
      assert.equal((await post(app, JSON.stringify({ text: "Доставка" }))).body.status, "ready");
      assert.deepEqual(await post(app, JSON.stringify({ text: marker })), {
        status: 200, body: manualReview,
      });
      assert.equal((await post(app, JSON.stringify({ text: "Стоимость" }))).body.status, "ready");
    });
  }
});

test("invalid model response types and fields are rejected", async (t) => {
  const outputs = [
    undefined, null, 42, {},
    "null", "[]", '"hello"', "42", "true", "{}",
    JSON.stringify({ topic: "delivery" }),
    JSON.stringify({ draft: "Ответ" }),
    JSON.stringify({ topic: null, draft: "Ответ" }),
    JSON.stringify({ topic: ["delivery"], draft: "Ответ" }),
    ...[null, 42, false, [], {}, "", " \n\t "].map((draft) => JSON.stringify({ topic: "delivery", draft })),
  ];
  for (const output of outputs) {
    await t.test(`output ${JSON.stringify(output)}`, async (t) => {
      const isolated = await startServer({ model: () => output });
      t.after(isolated.close);
      assert.deepEqual(await post(isolated, '{"text":"hello"}'), {
        status: 200, body: manualReview,
      });
    });
  }
});

test("only validated model fields are returned", async (t) => {
  const isolated = await startServer({
    model: () => JSON.stringify({
      status: "manual_review", topic: "other", draft: "  Ответ  ", extra: "ignore me",
    }),
  });
  t.after(isolated.close);
  assert.deepEqual(await post(isolated, '{"text":"hello"}'), {
    status: 200, body: { status: "ready", topic: "other", draft: "Ответ" },
  });
});

test("the 300 ms deadline aborts the model even if it ignores the signal", async (t) => {
  let modelSignal;
  const isolated = await startServer({
    model: (_text, { signal }) => {
      modelSignal = signal;
      return new Promise(() => {});
    },
  });
  t.after(isolated.close);
  const started = performance.now();
  assert.deepEqual(await post(isolated, '{"text":"hello"}'), {
    status: 200, body: manualReview,
  });
  const elapsed = performance.now() - started;
  assert.equal(modelSignal.aborted, true);
  // Allow scheduling overhead, but distinguish the 300 ms deadline from 1.2 s.
  assert.ok(elapsed >= 250 && elapsed < 1_000, `response took ${elapsed} ms`);
});

test("the page is served and unknown routes return 404", async () => {
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /Входящие заявки/);
  for (const [path, method] of [["/api/triage", "GET"], ["/missing", "POST"]]) {
    const reply = await fetch(`${app.url}${path}`, { method });
    assert.equal(reply.status, 404);
    assert.deepEqual(await reply.json(), { status: "not_found" });
  }
});
