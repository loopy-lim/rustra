// Self-contained Dynamic Command Registry demo.
// 런타임에 명령을 register / replace / unregister 하고 변경을 live 로 관찰한다.
// debug 빌드(rust lib)에서만 동작. release 는 frozen.
// 벤치마크나 rkyv-registry 의존성 없이 JSON 경로(createJsonEngine)만 사용한다.
import { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { installRustraJSI, getRustraNative } from '@rustra/generated-react-native';
import { createJsonEngine } from "./src/adapters/json-adapter";
import { createRkyvV2Engine, getLiveSchema } from "@rustra/types";
import { subscribeEvent } from "../../packages/react-native/src";
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from "../calculator/generated/contract";

type Engine = ReturnType<typeof createJsonEngine>;

async function runDemo(engine: Engine, log: (s: string) => void): Promise<void> {
  const call = async (command: string, args?: unknown) => {
    try {
      const result = await engine.invoke<Record<string, unknown>>(command, args);
      return { ok: true as const, result };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  };

  log("╔══════════════════════════════════════════════╗");
  log("║   Dynamic Command Registry (runtime mutation) ║");
  log("╚══════════════════════════════════════════════╝");

  const st = await call("rustraRegistryDemo", { op: "state" });
  log(`frozen = ${st.ok ? st.result?.frozen : st.error}  (debug rust lib → mutable)`);

  const before = await call("ping", {});
  log(`1) ping before register : ok=${before.ok}`);

  const reg = await call("rustraRegistryDemo", { op: "register" });
  const ping1 = await call("ping", {});
  log(
    `2) ${reg.ok ? reg.result?.message : reg.error} → ping() = pong:${ping1.ok ? ping1.result?.pong : "?"}`,
  );

  await call("rustraRegistryDemo", { op: "replacePing" });
  const ping2 = await call("ping", {});
  log(
    `3) replace 'ping'        → ping() = pong:${ping2.ok ? ping2.result?.pong : "?"} (changed live)`,
  );

  await call("rustraRegistryDemo", { op: "replaceAdd" });
  const mul = await call("addNumbers", { a: 2, b: 3 });
  log(
    `4) replace 'addNumbers'  → addNumbers(2,3) = ${mul.ok ? mul.result?.value : mul.error} (× not +)`,
  );

  await call("rustraRegistryDemo", { op: "restoreAdd" });
  const add = await call("addNumbers", { a: 2, b: 3 });
  log(`5) restore 'addNumbers'  → addNumbers(2,3) = ${add.ok ? add.result?.value : add.error}`);

  await call("rustraRegistryDemo", { op: "unregister" });
  const after = await call("ping", {});
  log(`6) unregister 'ping'     → ping ok=${after.ok} (gone)`);

  // 동적 명령 + Vec<f64> 입력(가변 길이 배열)
  await call("rustraRegistryDemo", { op: "registerAvg" });
  const avg = await call("average", { numbers: [10, 20, 30, 40] });
  log(
    `7) register 'average' (Vec) → average([10,20,30,40]) = ${avg.ok ? avg.result?.average : avg.error} (count ${avg.ok ? avg.result?.count : "?"})`,
  );
  await call("rustraRegistryDemo", { op: "unregisterAvg" });
  const avgGone = await call("average", { numbers: [] });
  log(`8) unregister 'average'  → average ok=${avgGone.ok} (gone)`);
  log("");
  log("✅ live mutation — no rebuild/prebuild between steps");
}

async function runSingleEngineDemo(
  native: ReturnType<typeof getRustraNative>,
  log: (s: string) => void,
): Promise<void> {
  // 단일 rkyvV2 엔진: codec registry 가 비어있으므로 동적 명령은 Tier 3 fallback.
  const jsonEngine = createJsonEngine(native); // control(setup) 용
  const rkyvEngine = createRkyvV2Engine(native, new Map<string, any>(), {
    contractHash: GENERATED_CONTRACT_HASH,
    schemaVersion: SCHEMA_VERSION,
  });

  log("╔══════════════════════════════════════════════╗");
  log("║  Single rkyvV2 engine + live schema (Tier 3) ║");
  log("╚══════════════════════════════════════════════╝");

  const control = (op: string) =>
    jsonEngine.invoke("rustraRegistryDemo", { op });

  // 다양한 타입의 동적 명령을 등록하고 단일 rkyvV2 엔진으로(Tier 3 fallback) 호출.
  // 각 단계에서 live schema 의 commandId/types 를 확인한다.

  // (a) Vec<f64> 입력
  await control("registerAvg");
  let schema = getLiveSchema(native);
  let entry = schema.get("average");
  log(
    `[Vec]   live schema 'average' commandId=${entry?.commandId}`,
  );
  {
    const out = await rkyvEngine.invoke<{ average: number; count: number }>(
      "average",
      { numbers: [10, 20, 30, 40] },
    );
    log(`  engine.invoke('average') → avg=${out.average} count=${out.count}`);
  }
  await control("unregisterAvg");

  // (b) String 입출력
  await control("registerGreet");
  schema = getLiveSchema(native);
  entry = schema.get("greetDyn");
  log(
    `[String] live schema 'greetDyn' commandId=${entry?.commandId}`,
  );
  {
    const out = await rkyvEngine.invoke<{ message: string }>("greetDyn", {
      name: "rust 🦀",
    });
    log(`  engine.invoke('greetDyn') → ${out.message}`);
  }
  await control("unregisterGreet");

  // (c) Map<String, i64> 입력
  await control("registerMap");
  schema = getLiveSchema(native);
  entry = schema.get("scoreMap");
  log(`[Map]   live schema 'scoreMap' commandId=${entry?.commandId}`);
  {
    const out = await rkyvEngine.invoke<{ total: number; keys: number }>(
      "scoreMap",
      { scores: { a: 10, b: 32 } },
    );
    log(`  engine.invoke('scoreMap') → total=${out.total} keys=${out.keys}`);
  }
  await control("unregisterMap");

  // (d) 중첩 구조체 + Vec<구조체>
  await control("registerNested");
  schema = getLiveSchema(native);
  entry = schema.get("nestedEcho");
  log(`[Nested] live schema 'nestedEcho' commandId=${entry?.commandId}`);
  {
    const out = await rkyvV2InvokeSafe<{
      count: number;
      sum_x: number;
    }>(rkyvEngine, "nestedEcho", {
      p: { x: 1, y: 2 },
      items: [{ x: 10, y: 0 }, { x: 100, y: 0 }],
    });
    log(
      `  engine.invoke('nestedEcho') → ${out.ok ? `count=${out.result.count} sumX=${out.result.sum_x}` : out.error}`,
    );
  }
  await control("unregisterNested");
  log("");
  log("✅ 4 dynamic command types (Vec/String/Map/Nested) via single rkyvV2 engine (Tier 3)");
}

// rkyvV2 엔진 호출을 안전하게 래핑(에러도 화면에 표시).
async function rkyvV2InvokeSafe<T>(
  engine: ReturnType<typeof createRkyvV2Engine>,
  command: string,
  args: unknown,
): Promise<
  { ok: true; result: T } | { ok: false; error: string }
> {
  try {
    const result = await engine.invoke<T>(command, args);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Event push demo (Rust → JS) ───────────────────────────
// subscribeEvent 로 progress.tick / demo.done 를 등록한 뒤 emitDemo 커맨드로
// Rust 가 발행한 이벤트가 CallInvoker 를 거쳐 JS 콜백으로 도달하는지 관찰한다.
// 콜백은 파싱된 객체를 받는다(TS 래퍼가 JSON.parse 1회).
async function runEventPushDemo(
  native: ReturnType<typeof getRustraNative>,
  log: (s: string) => void,
): Promise<void> {
  const engine = createJsonEngine(native);

  log("╔══════════════════════════════════════════════╗");
  log("║     Event push (Rust emit → JS callback)      ║");
  log("╚══════════════════════════════════════════════╝");

  const ticks: number[] = [];
  let done: number | null = null;
  let ticksObserved = 0;
  let doneObserved = false;

  const unsubscribeTick = subscribeEvent("progress.tick", (payload) => {
    ticksObserved += 1;
    const p = payload as { step: number; total: number } | null;
    if (p) {
      ticks.push(p.step);
      log(`  ⬇ progress.tick step=${p.step}/${p.total}`);
    }
  });
  const unsubscribeDone = subscribeEvent("demo.done", (payload) => {
    doneObserved = true;
    const p = payload as { emitted: number } | null;
    if (p) {
      done = p.emitted;
      log(`  ⬇ demo.done emitted=${p.emitted}`);
    }
  });

  try {
    // ticks=5, 각 스텝 30ms — 순서 관찰용. 커맨드가 반환하기 전에도 이벤트가
    // 이미 큐를 거쳐 JS 로 스트리밍된다(push 경로).
    const result = await engine.invoke<{ emitted: number }>("emitDemo", {
      ticks: 5,
      stepDelayMs: 30,
    });
    log(`emitDemo returned emitted=${result.emitted}`);

    // drain 이 비동기(CallInvoker 예약)이므로 잠깐 대기 후 집계.
    await new Promise((r) => setTimeout(r, 150));
  } catch (e) {
    log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    unsubscribeTick();
    unsubscribeDone();
  }

  log("");
  log(
    `✅ ticks observed=${ticksObserved} (${ticks.join(",")}) done=${doneObserved} emitted=${done ?? "?"}`,
  );
}

export default function App() {
  const [lines, setLines] = useState<string[]>(["Installing JSI..."]);

  useEffect(() => {
    const out: string[] = [];
    const log = (s: string) => {
      out.push(s);
      setLines([...out]);
    };
    (async () => {
      try {
        await installRustraJSI();
        log("JSI installed. Creating JSON engine...");
        const engine = createJsonEngine(getRustraNative());
        await runDemo(engine, log);
        await runSingleEngineDemo(getRustraNative(), log);
        await runEventPushDemo(getRustraNative(), log);
      } catch (e) {
        log("ERROR: " + (e instanceof Error ? e.message : String(e)));
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll}>
        <Text style={styles.text}>{lines.join("\n")}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e", padding: 16, paddingTop: 60 },
  scroll: { flex: 1 },
  text: { fontFamily: "Courier", fontSize: 12, color: "#e0e0e0", lineHeight: 18 },
});
