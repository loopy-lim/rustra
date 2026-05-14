import type { HybridObject } from "react-native-nitro-modules";

export interface NitroBench
  extends HybridObject<{ ios: "c++"; android: "c++" }> {
  add(a: number, b: number): number;
  echo(value: number): number;
}
