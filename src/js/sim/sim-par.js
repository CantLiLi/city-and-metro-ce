'use strict';
// 交通分配的两套并行方案，由设置里的「计算进程」用 if 选择：
//   A 单进程：只有一片。一次请求把若干时段的若干轮整套算完再交回主线程。
//   B 多进程：时段分给池里各片，一片一段、互不等待——一片在算这一段时，别的片在算别的时段。
// 两条路径跑的都是 sim.js 里同一份 odOrigin / demandOrigin / odBuffer 源码（toString 注入）。
(function (CM) {
  const MAXT = 10;
  const PARRS = ['arcVol', 'arcTime', 'skimT', 'skimK', 'desTot', 'desMetro', 'zTrips', 'zMetro', 'zAccess', 'zDest', 'zDestM',
    'fIn', 'fInM', 'fOut', 'fOutM', 'fP', 'load', 'freq', 'crowd', 'stIn', 'stOut', 'stXfer', 'stBoard', 'stDelay'];
  const KER = ['od', 'dem', 'buf', 'grow', 'car', 'rt', 'load', 'tree', 'svc'];
  const kern = {};
  const pend = new Map();

  let isMulti = false, threads = 0, token = 0;
  let pool = [], dead = false, src = null, rr = 0, statKey = '', pub0 = null;

  // 片里跑的是这一段源码：需求表生成、一个时段的整套迭代、若干时段的循环求解。
  // 静态输入（需求表、路网、道路、方案参数、设施表）只在新值时推一次；一块自己的值随请求走。
  function workerSrc() {
    return 'var INF=1e30;var HW=0,SC=1,SH=2,MD=3,LZ=4,HB=5,NPK=6,PK=["hw","sc","sh","md","lz","hb"],TKEY=["tHW","tSC","tSH","tMD","tLZ","tHB"],MKEY=["mHW","mSC","mSH","mMD","mLZ","mHB"];' +
      'var U={dist:function(ax,ay,bx,by){var dx=bx-ax,dy=by-ay;return Math.sqrt(dx*dx+dy*dy);},clamp:function(v,a,b){return v<a?a:(v>b?b:v);}};' +
      'var odOrigin=(' + kern.od + ');' +
      'var demandOrigin=(' + kern.dem + ');' +
      'var odBuffer=(' + kern.buf + ');' +
      'var odGrow=(' + kern.grow + ');' +
      'var carOrigin=(' + kern.car + ');' +
      'var roadTree=(' + kern.rt + ');' +
      'var metroLoadFrom=(' + kern.load + ');' +
      'var metroTree=(' + kern.tree + ');' +
      'var serviceFloor=(' + kern.svc + ');' +
      'var S=null,SK="";' +
      'var heap={n:0,key:[],val:[],lastKey:0,clear:function(){this.n=0;},push:function(k,v){var i=this.n++;while(i>0){var p=(i-1)>>1;if(this.key[p]<=k)break;this.key[i]=this.key[p];this.val[i]=this.val[p];i=p;}this.key[i]=k;this.val[i]=v;},' +
      'pop:function(){var top=this.val[0],n=--this.n;this.lastKey=this.key[0];if(n>0){var kk=this.key[n],vv=this.val[n],i=0;for(;;){var l=i*2+1;if(l>=n)break;var r=l+1,c=(r<n&&this.key[r]<this.key[l])?r:l;if(this.key[c]>=kk)break;this.key[i]=this.key[c];this.val[i]=this.val[c];i=c;}this.key[i]=kk;this.val[i]=vv;}return top;}};' +
      'var PARLEN=' + PARRS.length + ',PARK=' + JSON.stringify(PARRS) + ';' +
      // 同一份 buffer 只能转手一次：多个视图可能共用同一块（od.t[0..5]、arr 里的同一批），重复会在 postMessage 处整条消息被拒
      'function trs(o){var tr=[],seen=[];for(var k in o){var a=o[k];if(a&&a.buffer&&a.byteLength&&seen.indexOf(a.buffer)<0){seen.push(a.buffer);tr.push(a.buffer);}}return tr;}' +
      'self.onmessage=function(e){var m=e.data;if(!m)return;' +
      'if(m.t==="stat"){if(m.key!==SK){SK=m.key;S=m.pub;}return;}' +
      'if(m.t==="demand"){goDemand(m);return;}' +
      'if(m.t==="solve"){goSolve(m);return;}};' +
      // ---- 需求表：各起点独立，一片算一段 ----
      'function goDemand(m){var D=m.D;try{var d=demand(D,D.from,D.to);' +
      'var st=new Int32Array(D.Z+1),n=0;for(var i=0;i<D.Z;i++)st[i+1]=n+=d.cnts[i-D.from];' +
      'self.postMessage({t:"demandR",id:m.id,start:st,dest:d.dest,t:d.t,tot:d.tot},trs({a:st,b:d.dest,c:d.t[0],d:d.t[1],e:d.t[2],f:d.t[3],g:d.t[4],h:d.t[5]}));' +
      '}catch(err){self.postMessage({t:"err",id:m.id,msg:String(err&&err.message||err),stack:String(err&&err.stack||"")});}}' +
      'var _dm=null;' +
      'function demand(D,from,to){var Z=D.Z,F=D.F,per=D.per,len=to-from;if(!_dm||_dm.Z!==Z)_dm={Z:Z};' +
      'var dm=_dm;dm.Z=Z;dm.F=F;dm.per=per;' +
      'for(var k in D)dm[k]=D[k];' +
      'var cap=len*140+64,o=odBuffer(cap);dm.out=o;dm.n=0;dm.tot=new Float64Array(6);' +
      'dm.w=[new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z)];' +
      'dm.wf=[null,new Float64Array(F),new Float64Array(F),new Float64Array(F),new Float64Array(F)];' +
      'dm.scores=new Float64Array(Z);dm.s=new Float64Array(5);dm.kk=new Float64Array(5);' +
      'dm.cand=new Int32Array(Z);dm.candF=new Int32Array(F>0?F:1);' +
      'var cnts=new Int32Array(len);' +
      'for(var i=from;i<to;i++){if(o.cap-dm.n<per){o=odGrow(o,dm.n,Math.max(o.cap*2,dm.n+per*4));dm.out=o;}demandOrigin(dm,i);cnts[i-from]=dm.n;}' +
      'var dest=new Int32Array(dm.n);dest.set(o.dest.subarray(0,dm.n));' +
      'var t=[];for(var q=0;q<6;q++){var a=new Float32Array(dm.n);a.set(o.t[q].subarray(0,dm.n));t.push(a);}' +
      'return {cnts:cnts,dest:dest,t:t,tot:dm.tot};}' +
      // ---- 一个时段：与主线程 iterate() 串行段顺序一致（最短路 → 方式选择 → 地铁加载与调度 → 汽车分配 → 平滑）----
      'function ONE(F){var P=F.arr,S1=S;if(!S1)throw new Error("stat 未就绪");var C=S1.cfg,T=C.trips,SPL=T.split[F.dt],hrs=C.pHours[F.p];var co=new Float64Array(NPK),cr=new Float64Array(NPK),WM=(F.dt==="we"?C.wk:null);' +
      'for(var q=0;q<NPK;q++){var mm=WM?WM[q]:1;co[q]=mm*SPL[PK[q]].o[F.p]/hrs;cr[q]=mm*SPL[PK[q]].r[F.p]/hrs;}' +
      'var skT=P.skimT,skK=P.skimK,net=S1.net,road=S1.road;' +
      'var facW=!!F.facW,IND=T.induced,hasMetro=!!(net&&net.R>0),stable=F.iters>0;' +
      'var store=null;' +
      'var Z=S1.Z,NZ=S1.NZ,N=net?net.N:0,Zz=Z,pT,pM;' +
      'if(hasMetro){store=SKIM(net,P,hrs,S1);store.D.fill(0);}' +
      'var ODF=F.od2?F.od2:S1.od,odOkNow=F.od2?true:(S1.od.F===S1.F&&S1.od.key===S1.facKey);' +
      'var oaStart=ODF.start,oaDest=ODF.dest,oaT=ODF.t;' +
      'if(!P.carDem||P.carDem.length!==Zz*Zz)P.carDem=new Float64Array(Zz*Zz);' +
      'if(!P.hasCar||P.hasCar.length!==Zz)P.hasCar=new Uint8Array(Zz);' +
      'var carDem=P.carDem,hasCar=P.hasCar;carDem.fill(0);hasCar.fill(0);' +
      'var st={trips:0,metro:0,car:0,timeSum:0,commTrips:0,commTime:0,fare:0,metroPkm:0,vkt:0,carPkm:0,congNum:0,congDen:0,crowdPkm:0,metroTime:0,carTime:0,' +
      'tHW:0,tSC:0,tSH:0,tMD:0,tLZ:0,tHB:0,mHW:0,mSC:0,mSH:0,mMD:0,mLZ:0,mHB:0,ind:0,indM:0};' +
      'pT=new Float64Array(NPK);pM=new Float64Array(NPK);' +
      'var acc=hasMetro?net.acc:null,accOk=!!(acc&&acc.NZ===NZ&&acc.facKey===S1.facKey);' +
      'P.desTot.fill(0);P.desMetro.fill(0);P.zTrips.fill(0);P.zMetro.fill(0);P.zAccess.fill(0);' +
      'P.zDest.fill(0);P.zDestM.fill(0);P.fIn.fill(0);P.fInM.fill(0);P.fOut.fill(0);P.fOutM.fill(0);P.fP.fill(0);' +
      'if(!P.choice||P.choice.length!==NZ*NZ)P.choice=new Int8Array(NZ*NZ);P.choice.fill(-2);P.skimT.fill(0);P.skimK.fill(0);' +
      'var K={Z:Zz,NZ:NZ,N:N,B:S1.B,odStart:oaStart,odDest:oaDest,t0:oaT[0],t1:oaT[1],t2:oaT[2],t3:oaT[3],t4:oaT[4],t5:oaT[5],' +
      'co:co,cr:cr,cO:new Float64Array(NPK),cR:new Float64Array(NPK),facW:facW,facWe:S1.facWe,odOk:odOkNow,' +
      'hostZ:S1.hostZ,nx:S1.nx,ny:S1.ny,skT:skT,skK:skK,kmPerCell:S1.kmPerCell,' +
      'cpk:S1.prm.cpk,park:S1.prm.park,vot:S1.prm.vot,carAccess:S1.prm.carAccess,walkW:S1.prm.walkW,occ:S1.prm.occ,theta:S1.prm.theta,fareFlat:S1.fareFlat,' +
      'acc:acc,accOk:accOk,choices:P.choice,gtS:store?store.gt:null,tmS:store?store.tm:null,kmS:store?store.km:null,DS:store?store.D:null,' +
      'perMin:S1.perMin,capSh:S1.capSh,capLz:S1.capLz,carDem:carDem,hasCar:hasCar,totStat:new Float64Array(14),pT:pT,pM:pM,' +
      'zTrips:P.zTrips,zMetro:P.zMetro,zAccess:P.zAccess,zJ:S1.zJ,blocks:BLOCKS(S1),desTot:P.desTot,desMetro:P.desMetro,' +
      'zDest:P.zDest,zDestM:P.zDestM,fIn:P.fIn,fInM:P.fInM,fOut:P.fOut,fOutM:P.fOutM,fP:P.fP};' +
      'if(acc&&!accOk){acc=null;K.acc=null;K.accOk=false;}' +
      'for(var i=0;i<Zz;i++)odOrigin(K,i);' +
      'var ts=K.totStat;' +
      'st.trips=ts[0];st.metro=ts[1];st.car=ts[2];st.timeSum=ts[3];st.carTime=ts[4];st.metroTime=ts[5];st.fare=ts[6];st.metroPkm=ts[7];st.carPkm=ts[8];st.vkt=ts[9];' +
      'st.commTrips=ts[10];st.commTime=ts[11];st.ind=ts[12];st.indM=ts[13];' +
      'for(var q=0;q<NPK;q++){st[TKEY[q]]=pT[q];st[MKEY[q]]=pM[q];}' +
      'if(hasMetro){' +
      'var lam=F.metroLam||0.5,nn=net.nNodes,nE=net.nE;' +
      'var wk={load:new Float32Array(nE),accN:new Float64Array(nn),stIn:new Float32Array(N),stOut:new Float32Array(N),stBoard:new Float32Array(N),walkIn:new Float32Array(N)};' +
      'for(var s=0;s<N;s++)metroLoadFrom(net,store,s,wk);' +
      'for(var e=0;e<nE;e++){var old=P.load[e];P.load[e]=old*(1-lam)+wk.load[e]*lam;if(old!==P.load[e])stable=false;}' +
      'var stB=wk.stBoard,wIn=wk.walkIn;' +
      'for(e=0;e<nE;e++){var ty=net.eType[e];if(ty===0)stB[net.eSt[e]]+=P.load[e];else if(ty===3)wIn[net.eSt[e]]+=P.load[e];}' +
      'var mc=C.metro;' +
      'for(var s=0;s<N;s++){var oi=P.stIn[s],oo=P.stOut[s],odl=P.stDelay[s];' +
      'P.stIn[s]=P.stIn[s]*(1-lam)+wk.stIn[s]*lam;P.stOut[s]=P.stOut[s]*(1-lam)+wk.stOut[s]*lam;P.stBoard[s]=stB[s];' +
      'P.stXfer[s]=Math.max(0,stB[s]-P.stIn[s]-wIn[s]);' +
      'var sc=(net.C&&net.C.stations)?net.C.stations[s].size:1,cap=mc.stationCap[sc],ratio=(P.stIn[s]+P.stOut[s]+P.stXfer[s])/cap,dl=U.clamp((ratio-0.8)*10,0,12);' +
      'P.stDelay[s]=P.stDelay[s]*0.5+dl*0.5;' +
      'if(oi!==P.stIn[s]||oo!==P.stOut[s]||odl!==P.stDelay[s])stable=false;}' +
      'for(var r=0;r<net.R;r++){var rt=net.C.routes[r],re=net.rideEdge[r],mx=0;' +
      'for(var q=0;q<re.length;q++)if(P.load[re[q]]>mx)mx=P.load[re[q]];' +
      'var need=U.clamp(Math.max(mx/(rt.cap*mc.targetLF),serviceFloor(rt,F.p)),1,mc.fMax);' +
      'var of=P.freq[r];P.freq[r]=of*0.55+need*0.45;if(of!==P.freq[r])stable=false;' +
      'for(q=0;q<re.length;q++){var e=re[q],LF=P.load[e]/Math.max(1,P.freq[r]*rt.cap),cf=1;' +
      'if(LF>0.6)cf=1+0.25*Math.min(1,(LF-0.6)/0.4);if(LF>1)cf=1.25+1.6*(LF-1);' +
      'var oc=P.crowd[e];P.crowd[e]=Math.min(3.5,oc*0.5+cf*0.5);if(oc!==P.crowd[e])stable=false;' +
      'if(LF>1)st.crowdPkm+=P.load[e]*net.eKm[e];}}}' +
      'var rw=F.slot&&F.slot.aux&&F.slot.aux.length===road.nA?F.slot:NEEDROAD(S1);' +
      'rw.aux.fill(0);rw.accN.fill(0);' +
      'var cw={road:road,rd:S1.roadData,time:P.arcTime,work:rw,heap:heap,skT:skT,skK:skK,carDem:carDem,Z:Zz};' +
      'var cs=S1.roadData.start,zPop=S1.zJ||null,fullSkim=!!F.fullSkim,iters=F.iters;' +
      'for(var o=0;o<Zz;o++){var c0=cs[o],c1=cs[o+1];if(c0===c1)continue;' +
      'if(!hasCar[o]&&!(fullSkim&&zPop[o]>0)&&iters>0)continue;' +
      'if(!carOrigin(cw,o,stable))stable=false;}' +
      'var nA=road.nA,lam2=F.iters===0?1:(F.lam||C.rm),A=S1.bprA,capF=S1.capF||1;' +
      'for(var a=0;a<nA;a++){var ov=P.arcVol[a],ot=P.arcTime[a],v=ov*(1-lam2)+rw.aux[a]*lam2;P.arcVol[a]=v;' +
      'var x=v/(road.arcCap[a]*capF);P.arcTime[a]=road.arcT0[a]*Math.min(8,1+A*x*x*x*x);' +
      'if(ov!==P.arcVol[a]||ot!==P.arcTime[a])stable=false;' +
      'st.congNum+=v*road.arcLen[a]*(P.arcTime[a]/road.arcT0[a]);st.congDen+=v*road.arcLen[a];}' +
      'P.iters++;P.facKey=S1.facKey;' +
      'if(P.stats&&!F.noSmooth){var o2=P.stats;for(var k in st)if(o2[k]!==undefined)st[k]=o2[k]*0.4+st[k]*0.6;}' +
      'if(stable&&P.stats)for(var k in st)if(st[k]!==P.stats[k]){stable=false;break;}' +
      'P.stats=st;P.stable=stable;' +
      'var arr=[];for(var k=0;k<PARLEN;k++)arr.push(P[PARK[k]]||null);' +
      'return {arr:arr,iters:P.iters,stable:stable,facKey:S1.facKey,stats:st};}' +
      'var _bl=null,_zs=null;' +
      'function BLOCKS(S1){if(_bl&&_zs===S1&&_bl.length===S1.Z)return _bl;var Z=S1.Z,bw=S1.bw,zw=S1.zw;' +
      '_bl=new Int32Array(Z);for(var z=0;z<Z;z++)_bl[z]=(((z/zw)|0)>>1)*bw+((z%zw)>>1);_zs=S1;return _bl;}' +
      'var _rw=null;' +
      'function NEEDROAD(S1){var r=S1.road;if(!_rw||_rw.aux.length!==r.nA)_rw={aux:new Float32Array(r.nA),dist:new Float64Array(r.nN),dkm:new Float64Array(r.nN),pred:new Int32Array(r.nN),order:new Int32Array(r.nN),accN:new Float64Array(r.nN)};return _rw;}' +
      'var _st=null,_cst=null,_cta=null,_wt=null;' +
      'function SKIM(net,P,hrs,S1){var N=net.N,nn=net.nNodes,nE=net.nE,prm=S1.prm;' +
      'if(!_st||_st.N!==N||_st.nn!==nn)_st={N:N,nn:nn,gt:new Float32Array(N*N),tm:new Float32Array(N*N),km:new Float32Array(N*N),pred:new Int32Array(N*nn),order:new Int32Array(N*nn),nOrd:new Int32Array(N),D:new Float32Array(N*N)};' +
      'var store=_st,cost=_cst,tAct=_cta;' +
      'if(!cost||cost.length!==nE){cost=_cst=new Float32Array(nE);tAct=_cta=new Float32Array(nE);}' +
      'for(var e=0;e<nE;e++){var ty=net.eType[e];' +
      'if(ty===0){var f=Math.max(0.5,P.freq[net.eRoute[e]]),w=60/(2*f);cost[e]=prm.waitW*w+prm.tpen+P.stDelay[net.eSt[e]];tAct[e]=w+P.stDelay[net.eSt[e]]*0.5;}' +
      'else if(ty===2){cost[e]=net.eT0[e]*P.crowd[e];tAct[e]=net.eT0[e];}' +
      'else if(ty===3){cost[e]=prm.walkW*net.eT0[e]+prm.opn;tAct[e]=net.eT0[e];}}' +
      'var wk=_wt;if(!wk||wk.dist.length!==nn)wk=_wt={dist:new Float64Array(nn),dtm:new Float32Array(nn),dkm:new Float32Array(nn)};' +
      'for(var s=0;s<N;s++)metroTree(net,cost,tAct,s,wk,store,heap,prm.tpen);' +
      'return store;}' +
      // ---- 单进程：若干时段的若干轮在片里一轮接一轮算完 ----
      'function goSolve(m){try{var jobs=m.jobs,out=[],r=null,i=0,src=null;' +
      'for(i=0;i<jobs.length;i++){var F=jobs[i];' +
      'if(src&&i>0&&F.dt===jobs[i-1].dt&&F.p===jobs[i-1].p)CONT(F.arr,src.arr);' +
      'for(var c=0;c<m.cycles;c++)r=ONE(F);src=r;' +
      'out.push({arr:r.arr,iters:r.iters,stable:r.stable,facKey:r.facKey,stats:r.stats});}' +
      'for(i=0;i<out.length;i++){var ar=out[i].arr,ck=PARK.indexOf("choices");if(ck>=0&&ar[ck])ar[ck]=new Int8Array(ar[ck]);}' +
      // 同一份 buffer 只能转手一次：arr 里多个槽可能指向同一块（如 carDem 与 hasCar 互不重合，但复用的缓冲区会重合），重复会被 postMessage 整条拒绝
      'var tr=[],seen=[];' +
      'for(i=0;i<out.length;i++)for(var k=0;k<out[i].arr.length;k++){var a=out[i].arr[k];if(a&&a.buffer&&a.byteLength&&seen.indexOf(a.buffer)<0){seen.push(a.buffer);tr.push(a.buffer);}}' +
      'self.postMessage({t:"solved",id:m.id,per:out},tr);' +
      '}catch(err){self.postMessage({t:"err",id:m.id,msg:String(err&&err.message||err),stack:String(err&&err.stack||"")});}}' +
      'function CONT(dst,src){for(var k=0;k<PARLEN;k++){var a=dst[PARK[k]],b=src[PARK[k]];if(a&&b&&a!==b)a.set(b);}if(dst.carDem&&src.carDem&&dst.carDem.length===src.carDem.length)dst.carDem.set(src.carDem);if(dst.hasCar&&src.hasCar&&dst.hasCar.length===src.hasCar.length)dst.hasCar.set(src.hasCar);dst.iters=src.iters;dst.stats=src.stats;}';
  }

  function envOk() {
    return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && !!URL.createObjectURL;
  }

  function wantW() {
    if (!isMulti) return 1;
    const n = threads > 0 ? threads : Math.max(1, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 1);
    return Math.max(1, Math.min(MAXT, n | 0));
  }

  function onMsg(e) {
    const m = e.data;
    if (!m) return;
    if (m.t === 'err' && m.msg) console.error('[SimPar] 片里出错:', m.msg);
    const p = m.id != null ? pend.get(m.id) : null;
    if (!p) return;
    pend.delete(m.id);
    if (m.t === 'demandR') p.res({ start: m.start, dest: m.dest, t: m.t, tot: m.tot });
    else if (m.t === 'solved') p.res({ per: m.per });
    else p.res(null);
  }

  function hook(w) {
    w.onmessage = onMsg;
    // 片里抛错这条片就废了：挂在它身上的等待全部放开（null），调用方看到失败就回退串行
    w.onerror = function (ev) {
      if (ev && ev.message) console.error('[SimPar] worker 错误:', ev.message, 'line', ev.lineno);
      dead = true;
      for (const id of Array.from(pend.keys())) {
        const p = pend.get(id);
        if (p && p.w === w) { pend.delete(id); p.res(null); }
      }
    };
    return w;
  }

  function closePool() {
    for (const w of pool) { try { w.terminate(); } catch (e) {} }
    pool = [];
    src = null;
    statKey = '';
    pub0 = null;
  }

  // 池按当前模式的片数建；片数变了就重建（还有请求在等时先不拆，等下一轮）
  function boot() {
    if (dead || !kern.od) return false;
    const want = wantW();
    if (pool.length === want) return true;
    if (pool.length) {
      if (pend.size) return false;
      closePool();
    }
    if (!envOk()) { dead = true; return false; }
    try { src = workerSrc(); } catch (e) { dead = true; return false; }
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      for (let i = 0; i < want; i++) pool.push(hook(new Worker(url)));
    } catch (e) { dead = true; closePool(); return false; }
    finally { if (url) { try { URL.revokeObjectURL(url); } catch (e2) {} } }
    return pool.length > 0;
  }

  function send(w, m, id) {
    try { w.postMessage(m); return true; }
    catch (e) {
      const p = id != null && id > 0 ? pend.get(id) : null;
      if (p) { pend.delete(id); p.res(null); }
      return false;
    }
  }

  // 静态输入只在内容变了的时候推：参数、票价、时段表、需求表在别的时段之间也会变（年份推进、调价），
  // 所以每份都比一遍。这里不清池子——清池会把还在算的请求连同刚发出去的静态输入一起丢掉。
  function sameRef(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    for (const k in a) if (a[k] !== b[k]) return false;
    for (const k in b) if (!(k in a)) return false;
    return true;
  }
  // od 可能还没建出来（城市刷新刚把上一份扔掉、新一轮需求表还没落地），所以按 K.od 判空
  function statKeyOf(K) {
    const road = K.road || {}, net = K.net || {}, od = K.od || {};
    return [K.Z, K.NZ, K.F, K.B, K.bw, K.zw, net.N ? 1 : 0, net.acc ? 1 : 0, road.nA || 0, road.nN || 0,
      net.N || 0, net.nE || 0, net.nNodes || 0, net.R || 0, od.dest ? od.dest.length : 0, od.start ? od.start.length : 0,
      K.facKey, K.fIn ? K.fIn.length : 0, K.fareFlat, K.perMin, K.capSh, K.capLz, K.bprA].join(':');
  }
  // od 没算出来（上一轮刚重置掉）就别把这份推下去：片里会拿一份缺 od 的静态输入算，整片全错。
  // 返回 false 让调用方按失败处理，走串行补一轮，等需求表回来再进池。
  function pushStat(K) {
    if (!K.od || !K.od.start || !K.od.dest) return false;
    const key = statKeyOf(K);
    const old = pub0;
    if (key === statKey && old && sameRef(old.cfg, K.cfg) && sameRef(old.prm, K.prm) && sameRef(old.od, K.od)
      && old.facKey === K.facKey && old.fareFlat === K.fareFlat && old.zJ === K.zJ) return true;
    const f = K.frame || { cfg: K.cfg, prm: K.prm };
    const pub = {};
    for (const k in K) if (k !== 'frame') pub[k] = K[k];
    pub.cfg = f.cfg; pub.prm = f.prm;
    for (let i = 0; i < pool.length; i++) {
      try { pool[i].postMessage({ t: 'stat', key: key, pub: pub }); }
      catch (e) { return false; }
    }
    statKey = key;
    pub0 = pub;
    return true;
  }

  // 交给片的一块：迭代输入的数组地址直接共享（同一进程），时段自己的值随消息走
  function payload(K) {
    return { dt: K.dt, p: K.p, iters: K.iters, fullSkim: !!K.fullSkim, noSmooth: !!K.noSmooth,
      lam: K.lam, capF: K.capF, metroLam: K.metroLam, facW: !!K.facW, arr: K.arr };
  }

  CM.SimPar = {
    setKernel(k) {
      const o = k || {};
      let same = true;
      for (const key of KER) {
        if (o[key] !== kern[key]) { kern[key] = o[key]; same = false; }
      }
      if (!same) { closePool(); dead = false; }
    },
    setMode(multi) {
      multi = !!multi;
      isMulti = multi;
      threads = 0;
      dead = false;
      closePool();
      return true;
    },
    multi() { return isMulti; },
    ready() { return boot(); },
    count() { return pool.length; },
    setThreads(n) {
      n = Math.max(1, Math.min(MAXT, (+n | 0) || 2));
      if (n === threads) return true;
      threads = n;
      dead = false;
      closePool();
      return true;
    },
    stop() { closePool(); return true; },
    // A 单进程：所有时段的几轮一起打包，片里一轮接一轮算完再交回
    solveAll(K, req) {
      if (!boot() || !pushStat(K)) return null;
      const id = ++token, jobs = [];
      const NP = req.NP || 4;
      for (const dt of req.dts) for (let p = 0; p < NP; p++) {
        const j = payload(K);
        j.dt = dt; j.p = p;
        jobs.push(j);
      }
      const w = pool[0];
      return new Promise(function (res) {
        pend.set(id, { res: res, w: w });
        if (!send(w, { t: 'solve', id: id, cycles: req.cycles, jobs: jobs }, id)) res(null);
      });
    },
    // 一片一段：谁回来谁再领下一段，片之间不等待
    request(K, slot) {
      if (!boot() || !pushStat(K)) return null;
      const id = ++token, w = pool[rr++ % pool.length];
      const msg = payload(K);
      if (slot) msg.slot = slot;
      return new Promise(function (res) {
        pend.set(id, { res: res, w: w });
        if (!send(w, { t: 'solve', id: id, cycles: 1, jobs: [msg] }, id)) res(null);
      });
    },
    // 需求表：各起点独立，B 分给各片，A 全给那一片
    demand(D, Z) {
      if (!boot()) return null;
      const n = pool.length, parts = [];
      for (let i = 0; i < n; i++) {
        const from = Math.floor(Z * i / n), to = Math.floor(Z * (i + 1) / n);
        if (to > from) parts.push([from, to, i]);
      }
      const ps = parts.map(function (pt) {
        const id = ++token, w = pool[pt[2]];
        const f = {};
        for (const k in D) f[k] = D[k];
        f.from = pt[0];
        f.to = pt[1];
        return new Promise(function (res) {
          pend.set(id, { res: res, w: w });
          send(w, { t: 'demand', id: id, D: f }, id);
        });
      });
      return Promise.all(ps).then(function (list) {
        if (list.some(function (r) { return !r; })) return null;
        return stitchDemand(list, parts, Z);
      });
    },
    slot(s, v) { return true; },
    clear() { return true; }
  };

  // 各片各算一段起点；拼回整张表时只是按小区顺序接起来，片里用的还是同一套 demandOrigin
  function stitchDemand(list, parts, Z) {
    let tot = 0;
    for (const r of list) tot += r.dest.length;
    const start = new Int32Array(Z + 1), dest = new Int32Array(tot);
    const t = [0, 1, 2, 3, 4, 5].map(function () { return new Float32Array(tot); });
    const tot6 = new Float64Array(6);
    let at = 0;
    for (let i = 0; i < parts.length; i++) {
      const r = list[i], from = parts[i][0], to = parts[i][1];
      const base = start[from];
      for (let z = from; z < to; z++) start[z + 1] = base + r.cnts[z - from];
      dest.set(r.dest, at);
      for (let q = 0; q < 6; q++) { t[q].set(r.t[q], at); tot6[q] += r.tot[q]; }
      at += r.dest.length;
    }
    return { start: start, dest: dest, t: t, tot: tot6 };
  }
})(window.CM);
