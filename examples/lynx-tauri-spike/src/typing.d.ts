// Lynx 가 제공하는 NativeModules 글로벌에 rustra 모듈 타입을 선언한다.
// 스파이크 호스트(desktop C++)가 extension-module BTS 주입으로 RustraModule 을 등록한다.
declare let NativeModules: {
  RustraModule: {
    invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
    // 스파이크 검증용 ack (host.cpp 패턴 재사용). 미지원 호스트에선 optional.
    ackResult?(value: number): void;
  };
};
