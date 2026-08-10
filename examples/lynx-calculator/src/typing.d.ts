// Lynx 가 제공하는 NativeModules 글로벌에 rustra 모듈 타입을 선언한다.
// 실제 객체는 네이티브 쪽(iOS: register_module / Android: Lynx module setup)에서 등록된다.
declare let NativeModules: {
  RustraModule: {
    invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  };
};
