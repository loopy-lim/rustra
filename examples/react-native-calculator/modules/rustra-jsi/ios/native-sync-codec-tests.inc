static void codecTests(jsi::Runtime& rt) {
  run(rt, "bound HostFunctions retain fixed names across calls and GC", "checkBoundConversionWork();");
  run(rt, "context construction failure exposes no partial binding", "checkBoundConstructionFailure();");
  run(rt, "generic tuple input restores distinct result names and fresh descriptors", R"JS(
    const f=bind(16,"span"); const input={pair:["tuple caption",37]};
    const a=f(input); collect(); const b=f(input);
    assert(a!==b && a.first==="tuple caption" && a.second===37 && b.second===37);
    assert(Object.keys(a).join(",")==="first,second");
    for(const key of ["first","second"]) { const d=Object.getOwnPropertyDescriptor(a,key); assert(d.writable && d.enumerable && d.configurable); }
  )JS");
  run(rt, "bound results preserve order descriptors and fresh identity", R"JS(
    const f=bind(26,"benchEchoPair"); const a=f({name:"caption",value:7}), b=f({name:"caption",value:7});
    assert(a!==b && a.name==="caption" && a.value===7);
    assert(Object.keys(a).join(",")==="name,value");
    for(const key of ["name","value"]) { const d=Object.getOwnPropertyDescriptor(a,key); assert(d.writable && d.enumerable && d.configurable); }
  )JS");
  run(rt, "getter drops outer binding roots and reenters same and different contexts", R"JS(
    globalThis.outerBinding=bind(34,"parityEcho"); const other=bind(26,"benchEchoPair"); let inner, pair;
    const n=node();
    Object.defineProperty(n,"note",{get(){
      const active=globalThis.outerBinding; globalThis.outerBinding=null;
      delete globalThis.__rustraPropNameCache; globalThis.__rustraNative={replaced:true}; collect();
      inner=active({nodes:[node({},"inner")]}); pair=other({name:"other",value:9}); collect(); return "outer";
    }});
    const out=outerBinding({nodes:[n]});
    assert(out.nodes[0].note==="outer" && inner.nodes[0].note==="inner" && pair.name==="other" && pair.value===9);
    delete globalThis.outerBinding; delete globalThis.__rustraNative;
  )JS");
  run(rt, "nested result setter reentry and throw preserve context and fresh output", R"JS(
    const f=bind(34,"parityEcho"); let depth=0, inner, shouldThrow=false;
    Object.defineProperty(Object.prototype,"note",{configurable:true,set(value){
      if(shouldThrow) throw new Error("result setter");
      if(depth===0) { depth++; collect(); inner=f({nodes:[node({},"inner")]}); depth--; }
      Object.defineProperty(this,"note",{value,writable:true,enumerable:true,configurable:true});
    }});
    try {
      const out=f({nodes:[node({},"outer")]});
      assert(out.nodes[0].note==="outer" && inner.nodes[0].note==="inner");
      shouldThrow=true; const before=stat(0,"frames"); rejects(()=>f({nodes:[node()]}));
      assert(stat(0,"frames")===before+1,"decode failure retried handler");
      shouldThrow=false; assert(f({nodes:[node({},"after")]}).nodes[0].note==="after");
    } finally { delete Object.prototype.note; }
  )JS");
  run(rt, "bound contexts remain managed until VM shutdown", R"JS(
    globalThis.retainedShutdownBindings=[bind(34,"parityEcho"),bind(26,"benchEchoPair")];
    collect(); assert(retainedShutdownBindings[0]({nodes:[node({},"shutdown")]}).nodes[0].note==="shutdown");
  )JS");
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
    for(const count of [0,1,2,4,5,64,65,keys.length]) {
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
  run(rt, "map storage boundaries retain one getter snapshot in enumeration order", R"JS(
    const f=bind(34,"parityEcho");
    for(const count of [0,1,2,4,5,64,65]) {
      const keys=["z","a","10","2",...Array.from({length:61},(_,i)=>"key"+i)].slice(0,count);
      const m=Object.create(null), plain=Object.create(null), reads=[];
      // The test runtime disables block scoping; capture each key as a function argument.
      const getterFor=key=>()=>{reads.push(key);return plain[key];};
      for(const key of keys) {
        plain[key]="value:"+key;
        Object.defineProperty(m,key,{enumerable:true,get:getterFor(key)});
      }
      const expectedOrder=Object.keys(m).join("|");
      const out=f({nodes:[node(m)]}).nodes[0].metadata;
      assert(reads.join("|")===expectedOrder,"map getter count or enumeration order changed count="+count+" reads="+reads.join("|")+" expected="+expectedOrder);
      for(const key of keys) assert(out[key]===plain[key],"map getter value snapshot changed");
    }
  )JS");
  run(rt, "small and fallback maps retain long Unicode NUL keys", R"JS(
    const f=bind(34,"parityEcho"), keys=["long".repeat(200),"nul\0key","한글😀","\ufffd","tail"];
    for(const count of [4,5]) {
      const m=Object.create(null), reverse=Object.create(null);
      for(const key of keys.slice(0,count)) m[key]="value:"+key;
      for(const key of keys.slice(0,count).reverse()) reverse[key]=m[key];
      assert(encodedHex(34,{nodes:[node(m)]})===encodedHex(34,{nodes:[node(reverse)]}),"Unicode canonical order changed");
      const out=f({nodes:[node(m)]}).nodes[0].metadata;
      for(const key of keys.slice(0,count)) assert(out[key]===m[key],"Unicode key or value changed");
    }
  )JS");
  run(rt, "map getter throw and reentry preserve owned entries at storage boundaries", R"JS(
    const f=bind(34,"parityEcho");
    for(const count of [4,5]) {
      const m=Object.create(null), reads=[]; let inner;
      const getterFor=i=>()=>{
        reads.push(i);
        if(i===1) { collect(); inner=f({nodes:[node({inner:"nested"})]}); collect(); }
        return "outer:"+i;
      };
      for(let i=0;i<count;i++) Object.defineProperty(m,"key"+i,{enumerable:true,get:getterFor(i)});
      const out=f({nodes:[node(m)]}).nodes[0].metadata;
      assert(reads.join(",")===Array.from({length:count},(_,i)=>i).join(","),"reentry changed getter order count="+count+" reads="+reads.join(","));
      assert(inner.nodes[0].metadata.inner==="nested","nested map result changed");
      for(let i=0;i<count;i++) assert(out["key"+i]==="outer:"+i,"reentry lost outer map value");
      const throwing=Object.create(null), thrownReads=[];
      const throwingGetterFor=i=>()=>{
        thrownReads.push(i); if(i===1) throw new Error("map getter"); return "value:"+i;
      };
      for(let i=0;i<count;i++) Object.defineProperty(throwing,"key"+i,{enumerable:true,get:throwingGetterFor(i)});
      rejects(()=>f({nodes:[node(throwing)]}));
      assert(thrownReads.join(",")==="0,1","throwing map read additional getters");
      assert(f({nodes:[node({after:"ok"})]}).nodes[0].metadata.after==="ok","map throw contaminated next encode");
    }
  )JS");
  run(rt, "map prototype key retains existing output behavior", R"JS(
    const m=Object.create(null); m.__proto__="text";
    const out=bind(34,"parityEcho")({nodes:[node(m)]}).nodes[0].metadata;
    assert(!Object.prototype.hasOwnProperty.call(out,"__proto__"),"prototype semantics changed");
    assert(Object.getPrototypeOf(out)===Object.prototype);
  )JS");
  run(rt, "map lone surrogate normalization remains compatible", R"JS(
    for(const count of [2,5]) {
      const m=Object.create(null); m["\ud800"]="original"; m["\ufffd"]="normalized";
      for(let i=2;i<count;i++) m["padding"+i]="value";
      const out=bind(34,"parityEcho")({nodes:[node(m)]}).nodes[0].metadata;
      assert(out["\ufffd"]==="normalized" && !("\ud800" in out),"UTF8 normalization lookup changed");
    }
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
