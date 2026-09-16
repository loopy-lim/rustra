static void codecTests(jsi::Runtime& rt) {
  run(rt, "encode uses only invocation-owned property state", "checkConversionWork(3);");
  run(rt, "decode uses only invocation-owned property state", "checkConversionWork(4);");
  run(rt, "raw result owns its actual property name", "checkResultPropertyState(false);");
  run(rt, "buffer result owns its actual property name", "checkResultPropertyState(true);");
  run(rt, "map lookup reuses equivalent JSI strings", "checkConversionWork(0);");
  run(rt, "fixed names resolve outside node loops", "checkConversionWork(1);");
  run(rt, "map output directly creates named properties", "checkConversionWork(2);");
  run(rt, "buffer creation pressure and result exceptions release producing owner", "checkPressureFailure();");
  run(rt, "nested struct getter is one consistent object snapshot", R"JS(
    let reads=0;
    const value={get item(){reads++; return {active:true,name:"first",value:7};}};
    assert(encodedHex(9,value)==="0900010566697273740e","nested struct bytes");
    assert(reads===1,"nested struct getter repeated");
  )JS");
  run(rt, "owned buffer reports backing storage exactly once", R"JS(
    const f=bind(25,"benchEchoBytes",4);
    for (const size of [0,1,65536]) {
      globalThis.pressureInput=new ArrayBuffer(size); collect(); const before=externalBytes();
      globalThis.retained=f({data:pressureInput},pressureInput).data;
      assert(retained.byteLength===size);
      assert(externalBytes()===before+size,"owned backing store missing or double counted");
      retained=null; collect(); assert(externalBytes()===before,"released buffer pressure retained");
      pressureInput=null; collect();
    }
  )JS");
  run(rt, "optional getter encodes its first snapshot", R"JS(
    const f=bind(34,"parityEcho"); let reads=0; const n=node();
    Object.defineProperty(n,"note",{enumerable:true,get(){return ++reads===1 ? "first" : "second";}});
    const out=f({nodes:[n]}); assert(reads===1,"optional getter was read twice");
    assert(out.nodes[0].note==="first","optional encoded a different snapshot");
    for(const value of [null,undefined,"present"]) assert(f({nodes:[node({},value)]}).nodes[0].note===(value??null));
  )JS");
  run(rt, "map canonical order and long Unicode NUL keys", R"JS(
    const f=bind(34,"parityEcho"); const keys=["z","a","10","2","한글😀","long".repeat(200),"nul\0key","constructor","prototype",...Array.from({length:80},(_,i)=>"key"+i)];
    for(const count of [0,1,2,keys.length]) {
      const m=Object.create(null), reverse=Object.create(null);
      for(const k of keys.slice(0,count)) m[k]="v:"+k;
      for(const k of keys.slice(0,count).reverse()) reverse[k]=m[k];
      assert(encodedHex(34,{nodes:[node(m)]})===encodedHex(34,{nodes:[node(reverse)]}),"noncanonical map");
      const out=f({nodes:[node(m)]}).nodes[0].metadata;
      for(const k of keys.slice(0,count)) assert(out[k]===m[k],"map value changed");
    }
    const m=Object.create(null); let reads=0;
    Object.defineProperty(m,"key",{enumerable:true,get(){reads++;return "value";}});
    assert(f({nodes:[node(m)]}).nodes[0].metadata.key==="value" && reads===1,"map getter repeat");
  )JS");
  run(rt, "map prototype key retains existing output behavior", R"JS(
    const m=Object.create(null); m.__proto__="text";
    const out=bind(34,"parityEcho")({nodes:[node(m)]}).nodes[0].metadata;
    assert(!Object.prototype.hasOwnProperty.call(out,"__proto__"),"prototype semantics changed");
    assert(Object.getPrototypeOf(out)===Object.prototype);
  )JS");
  run(rt, "map lone surrogate normalization remains compatible", R"JS(
    const m=Object.create(null); m["\ud800"]="original"; m["\ufffd"]="normalized";
    const out=bind(34,"parityEcho")({nodes:[node(m)]}).nodes[0].metadata;
    assert(out["\ufffd"]==="normalized" && !("\ud800" in out),"UTF8 normalization lookup changed");
  )JS");
  run(rt, "getter throw and reentry leave subsequent codec usable", R"JS(
    const f=bind(34,"parityEcho"), n=node();
    Object.defineProperty(n,"note",{get(){throw new Error("getter");}});
    rejects(()=>f({nodes:[n]})); assert(f({nodes:[node({},"ok")]}).nodes[0].note==="ok");
    const recursive=node(); let inner;
    Object.defineProperty(recursive,"note",{get(){delete globalThis.__rustraPropNameCache; collect(); inner=f({nodes:[node({},"inner")]}); collect(); return "outer";}});
    assert(f({nodes:[recursive]}).nodes[0].note==="outer" && inner.nodes[0].note==="inner");
  )JS");
  run(rt, "owned buffer fresh bytes and producing core release", R"JS(
    const f=bind(25,"benchEchoBytes",4), input=new Uint8Array([0,1,127,255]);
    let output=f({data:input.buffer},input.buffer).data;
    assert(output!==input.buffer && new Uint8Array(output)[3]===255);
    input[0]=99; assert(new Uint8Array(output)[0]===0);
    publish(1); output=null; collect();
    publish(0); mode(0,1); const freed=stat(0,"ownedFrees"); rejects(()=>f({data:input.buffer},input.buffer));
    assert(stat(0,"ownedFrees")===freed+1,"error allocation not released immediately");
  )JS");
}
