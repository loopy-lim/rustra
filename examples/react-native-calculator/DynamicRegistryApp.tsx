// Self-contained Dynamic Command Registry demo.
// 런타임에 명령을 register / replace / unregister 하고 변경을 live 로 관찰한다.
// debug 빌드(rust lib)에서만 동작. release 는 frozen.
// 벤치마크나 rkyv-registry 의존성 없이 JSON 경로(createJsonEngine)만 사용한다.
import { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { installRustraJSI, getRustraNative } from "./modules/rustra-jsi/src";
import { createJsonEngine } from "./src/adapters/json-adapter";

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
      } catch (e) {
        log("ERROR: " + (e instanceof Error ? e.message : String(e)));
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll}>
        {lines.map((line, i) => (
          <Text key={i} style={styles.text}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e", padding: 16, paddingTop: 60 },
  scroll: { flex: 1 },
  text: { fontFamily: "Courier", fontSize: 12, color: "#e0e0e0", lineHeight: 18 },
});
