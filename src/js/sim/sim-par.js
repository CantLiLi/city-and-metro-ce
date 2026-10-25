'use strict';
// 交通分配的两套并行方案，由设置里的「计算进程」用 if 选择：
//   A 单进程：只开一个 Worker，整套分配（需求生成、方式选择、地铁加载与调度、汽车分配、汇总）都在这一个 Worker 里跑完再交回主线程。
//   B 多进程：拆成几块各占一个 Worker——人口块生成起点需求表，交通块按起点分担方式选择，地铁块做客流加载与调度，
//             最后由主线程把各块的中途结果并成一份状态。A 里各块是顺序调用的，B 里只是把它们搬到了不同的线程。
// 两条路径跑的都是 sim.js 里同一份 odOrigin / demandOrigin / odBuffer 源码（toString 注入）。
(function (CM) {
  const MAXT = 10;
  // 必须与 sim.js 的 ODSLOT 完全一致
  const OUT = ['totStat', 'pT', 'pM'];
  const STAT = ['Z', 'NZ', 'N', 'facW', 'facWe', 'odOk', 'kmPerCell', 'cpk', 'park', 'vot', 'carAccess', 'walkW', 'occ', 'theta', 'fareFlat', 'accOk',
    'perMin', 'capSh', 'capLz', 'hostZ', 'nx', 'ny', 'blocks', 'zJ'];
  const ODT = ['odStart', 'odDest', 't0', 't1', 't2', 't3', 't4', 't5'];
  // 多进程里负责「人口」那块，其余片按起点分担「交通」；地铁块固定是最后一片
  const ROLE = ['pop', 'traf'];
  const ACC = ['totStat', 'pT', 'pM'];
  const STATKEYS = STAT.concat(ODT);
  const pend = new Map();
  const pendA = new Map();

  let kernel = null, demKernel = null, bufKernel = null, growKernel = null;
  let carKernel = null, roadKernel = null, loadKernel = null, treeKernel = null, svcKernel = null, accKernel = null;
  let statKey = '', token = 0;
  let threads = 0, isMulti = false;

  // A 单进程的 Worker 源码：只开一个，整套流程（需求表、方式选择、地铁加载与调度、汽车分配、每日汇总）都在里面跑完
  function workerSrcA() {
    return 'var INF=1e30;' +
      'var npk=6,PK=["hw","sc","sh","md","lz","hb"];' +
      'var U={dist:function(ax,ay,bx,by){var dx=bx-ax,dy=by-ay;return Math.sqrt(dx*dx+dy*dy);},clamp:function(v,a,b){return v<a?a:(v>b?b:v);}};' +
      'var odOrigin=(' + kernel + ');' +
      'var demandOrigin=(' + demKernel + ');' +
      'var odBuffer=(' + bufKernel + ');' +
      'var odGrow=(' + growKernel + ');' +
      'var carOrigin=(' + carKernel + ');' +
      'var roadTree=(' + roadKernel + ');' +
      'var metroLoadFrom=(' + loadKernel + ');' +
      'var metroTree=(' + treeKernel + ');' +
      'var serviceFloor=(' + svcKernel + ');' +
      'var OUT=' + JSON.stringify(OUT) + ',ACC=' + JSON.stringify(ACC) + ',CFGX=null,net=null,road=null,roadData=null,S=null;' +
      'var heap={n:0,key:[],val:[],lastKey:0,clear:function(){this.n=0;},push:function(k,v){var i=this.n++;' +
      'while(i>0){var p=(i-1)>>1;if(this.key[p]<=k)break;this.key[i]=this.key[p];this.val[i]=this.val[p];i=p;}this.key[i]=k;this.val[i]=v;},' +
      'pop:function(){var top=this.val[0],k=this.key[0],n=--this.n;this.lastKey=k;if(n>0){var kk=this.key[n],vv=this.val[n],i=0;for(;;){var l=i*2+1;if(l>=n)break;' +
      'var r=l+1,c=(r<n&&this.key[r]<this.key[l])?r:l;if(this.key[c]>=kk)break;this.key[i]=this.key[c];this.val[i]=this.val[c];i=c;}this.key[i]=kk;this.val[i]=vv;}return top;}};' +
      'self.onmessage=function(e){var m=e.data;if(!m)return;' +
      'if(m.t==="cfg"){CFGX=m.cfg;return;}' +
      'if(m.t==="stat"){S=m.stat;net=S.net;road=S.road;roadData=S.roadData;return;}' +
      'if(m.t==="demandAll"){goDemandAll(m);return;}' +
      'if(m.t==="solve"){goSolve(m);return;}' +
      'if(m.t==="road"){goRoad(m);return;}' +
      'if(m.t==="daily"){goDaily(m);return;}};' +
      // ---- 需求表：整张一次算完 ----
      'function goDemandAll(m){var D=m.D,d=demand(D,0,D.Z);' +
      'var st=new Int32Array(D.Z+1),n=0;for(var i=0;i<D.Z;i++){n+=d.cnts[i];st[i+1]=n;}' +
      'self.postMessage({t:"demandA",id:m.id,start:st,dest:d.dest,t:d.t,tot:d.tot},[st.buffer].concat(d.t.map(function(a){return a.buffer;})));}' +
      'function demand(D,from,to){var Z=D.Z,F=D.F,per=D.per;var D2={},k;for(k in D)D2[k]=D[k];' +
      'var o=odBuffer((to-from)*per+64);D2.out=o;D2.n=0;D2.tot=new Float64Array(6);' +
      'D2.w=[new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z)];' +
      'D2.wf=[null,new Float64Array(F),new Float64Array(F),new Float64Array(F),new Float64Array(F)];' +
      'D2.scores=new Float64Array(Z);D2.s=new Float64Array(5);D2.kk=new Float64Array(5);' +
      'D2.cand=new Int32Array(Z);D2.candF=new Int32Array(F>0?F:1);' +
      'var cnts=new Int32Array(to-from);' +
      'for(var i=from;i<to;i++){if(o.cap-D2.n<per){o=odGrow(o,D2.n,Math.max(o.cap*2,D2.n+per*4));D2.out=o;}demandOrigin(D2,i);cnts[i-from]=D2.n;}' +
      'var dest=new Int32Array(D2.n);dest.set(o.dest.subarray(0,D2.n));' +
      'var t=[];for(var q=0;q<6;q++){var a=new Float32Array(D2.n);a.set(o.t[q].subarray(0,D2.n));t.push(a);}' +
      'return {cnts:cnts,dest:dest,t:t,tot:D2.tot};}' +
      // 每个 P 要带回的数组（与 PERARR 一致）
      'var PERARR="load,freq,crowd,stIn,stOut,stBoard,stXfer,stDelay,arcVol,arcTime,skimT,skimK,zTrips,zMetro,zAccess,desTot,desMetro,zDest,zDestM,fIn,fInM,fOut,fOutM,fP".split(",");' +
      'function arrOf(a){if(!a||!a.k)return a;var C=a.k==="f32"?Float32Array:(a.k==="f64"?Float64Array:(a.k==="i32"?Int32Array:(a.k==="u8"?Uint8Array:Float32Array)));return C.from(a.d);}' +
      'function pack(P){var o={};for(var i=0;i<PERARR.length;i++){var k=PERARR[i];if(P[k])o[k]=P[k];}o.__iters=P.iters|0;o.__stable=P.stable?1:0;o.__stats=P.stats?P.stats:null;return o;}' +
      // ---- 一整轮求解：每个 P 逐时段迭代，顺序与主线程 iterate() 完全一致 ----
      'function goSolve(m){try{' +
      'var per=[];for(var i=0;i<m.per.length;i++){var o=m.per[i],P={};for(var k in o.arr)P[k]=arrOf(o.arr[k]);P.iters=o.iters|0;per.push({P:P,p:o.p,dt:o.dt,cycles:m.cycles});}' +
      'for(var i=0;i<per.length;i++){for(var c=0;c<per[i].cycles;c++)iterate(per[i]);}' +
      'var out=[];for(var i=0;i<per.length;i++)out.push(pack(per[i].P));' +
      'self.postMessage({t:"solved",id:m.id,per:out},bufs(out));}catch(err){self.postMessage({t:"solveErr",id:m.id,msg:String(err&&err.message||err)});}}' +
      'function bufs(list){var tr=[];for(var i=0;i<list.length;i++){for(var k in list[i]){var a=list[i][k];if(a&&a.buffer&&a.byteLength)tr.push(a.buffer);}}return tr;}' +
      // 单个 P 的一次迭代：地铁最短路 → 方式选择 → 地铁加载与调度 → 汽车分配 → 平滑
      'function iterate(o){var P=o.P,p=o.p,dt=o.dt,C=CFGX,prm=C.prm,Z=S.Z,N=net?net.N:0,NZ=S.NZ;' +
      'var T=C.trips,SPL=T.split[dt==="we"?"we":"wd"],hrs=S.pHours[p];' +
      'var co=new Float64Array(npk),cr=new Float64Array(npk),WM=dt==="we"?(S.weekendMult||null):null;' +
      'for(var q=0;q<npk;q++){var mm=WM?WM[q]:1;co[q]=mm*SPL[PK[q]].o[p]/hrs;cr[q]=mm*SPL[PK[q]].r[p]/hrs;}' +
      'var facW=dt==="we",IND=T.induced,hasMetro=net&&net.R>0,stable=P.iters>0;' +
      'allocP(P);' +
      'var store=null;' +
      'if(hasMetro){store=skim(net,P,p,prm);store.D.fill(0);}' +
      'var Zz=Z;' +
      'if(!P.carDem||P.carDem.length!==Zz*Zz)P.carDem=new Float64Array(Zz*Zz);' +
      'if(!P.hasCar||P.hasCar.length!==Zz)P.hasCar=new Uint8Array(Zz);' +
      'var carDem=P.carDem,hasCar=P.hasCar;carDem.fill(0);hasCar.fill(0);' +
      'var st={trips:0,metro:0,car:0,timeSum:0,commTrips:0,commTime:0,fare:0,metroPkm:0,vkt:0,carPkm:0,congNum:0,congDen:0,crowdPkm:0,metroTime:0,carTime:0,' +
      'tHW:0,tSC:0,tSH:0,tMD:0,tLZ:0,tHB:0,mHW:0,mSC:0,mSH:0,mMD:0,mLZ:0,mHB:0,ind:0,indM:0};' +
      'var pT=new Float64Array(npk),pM=new Float64Array(npk),skT=P.skimT,skK=P.skimK;' +
      'var acc=hasMetro?net.acc:null,accOk=acc&&acc.NZ===NZ&&acc.facKey===S.facKey;' +
      'P.desTot.fill(0);P.desMetro.fill(0);P.zTrips.fill(0);P.zMetro.fill(0);P.zAccess.fill(0);' +
      'P.zDest.fill(0);P.zDestM.fill(0);P.fIn.fill(0);P.fInM.fill(0);P.fOut.fill(0);P.fOutM.fill(0);P.fP.fill(0);' +
      'if(!P.choice||P.choice.length!==NZ*NZ)P.choice=new Int8Array(NZ*NZ);' +
      'var K={Z:Zz,NZ:NZ,N:N,B:S.B,odStart:S.odStart,odDest:S.odDest,t0:S.t0,t1:S.t1,t2:S.t2,t3:S.t3,t4:S.t4,t5:S.t5,' +
      'co:co,cr:cr,cO:new Float64Array(npk),cR:new Float64Array(npk),facW:facW,facWe:S.facWe,odOk:true,' +
      'hostZ:S.hostZ,nx:S.nx,ny:S.ny,skT:skT,skK:skK,kmPerCell:S.kmPerCell,' +
      'cpk:prm.cpk,park:prm.park,vot:prm.vot,carAccess:prm.carAccess,walkW:prm.walkW,occ:prm.occ,theta:prm.theta,fareFlat:S.fareFlat,' +
      'acc:acc,accOk:!!accOk,choices:P.choice,gtS:store?store.gt:null,tmS:store?store.tm:null,kmS:store?store.km:null,DS:store?store.D:null,' +
      'perMin:IND.perMin,capSh:IND.cap.sh,capLz:IND.cap.lz,carDem:carDem,hasCar:hasCar,totStat:new Float64Array(14),pT:pT,pM:pM,' +
      'zTrips:P.zTrips,zMetro:P.zMetro,zAccess:P.zAccess,zJ:S.zJ,blocks:S.blocks,desTot:P.desTot,desMetro:P.desMetro,' +
      'zDest:P.zDest,zDestM:P.zDestM,fIn:P.fIn,fInM:P.fInM,fOut:P.fOut,fOutM:P.fOutM,fP:P.fP};' +
      'for(var i=0;i<Zz;i++)odOrigin(K,i);' +
      'var ts=K.totStat;' +
      'st.trips=ts[0];st.metro=ts[1];st.car=ts[2];st.timeSum=ts[3];st.carTime=ts[4];st.metroTime=ts[5];st.fare=ts[6];st.metroPkm=ts[7];st.carPkm=ts[8];st.vkt=ts[9];' +
      'st.commTrips=ts[10];st.commTime=ts[11];st.ind=ts[12];st.indM=ts[13];' +
      'for(var q=0;q<npk;q++){st[["tHW","tSC","tSH","tMD","tLZ","tHB"][q]]=pT[q];st[["mHW","mSC","mSH","mMD","mLZ","mHB"][q]]=pM[q];}' +
      'var lamM=0.5;' +
      'if(hasMetro){' +
      'var nn=net.nNodes,nE=net.nE;' +
      'var work={load:new Float32Array(nE),accN:new Float64Array(nn),stIn:new Float32Array(N),stOut:new Float32Array(N),stBoard:new Float32Array(N),walkIn:new Float32Array(N)};' +
      'for(var s=0;s<N;s++)metroLoadFrom(net,store,s,work);' +
      'for(var e=0;e<nE;e++){var old=P.load[e];P.load[e]=old*(1-lamM)+work.load[e]*lamM;if(old!==P.load[e])stable=false;}' +
      'var stB=work.stBoard,wIn=work.walkIn;' +
      'for(var e=0;e<nE;e++){var ty=net.eType[e];if(ty===0)stB[net.eSt[e]]+=P.load[e];else if(ty===3)wIn[net.eSt[e]]+=P.load[e];}' +
      'var mc=C.metro;' +
      'for(var s=0;s<N;s++){var oi=P.stIn[s],oo=P.stOut[s],od=P.stDelay[s];' +
      'P.stIn[s]=P.stIn[s]*(1-lamM)+work.stIn[s]*lamM;P.stOut[s]=P.stOut[s]*(1-lamM)+work.stOut[s]*lamM;P.stBoard[s]=stB[s];' +
      'P.stXfer[s]=Math.max(0,stB[s]-P.stIn[s]-wIn[s]);' +
      'var cap=mc.stationCap[net.C.stations[s].size],ratio=(P.stIn[s]+P.stOut[s]+P.stXfer[s])/cap,dl=U.clamp((ratio-0.8)*10,0,12);' +
      'P.stDelay[s]=P.stDelay[s]*0.5+dl*0.5;' +
      'if(oi!==P.stIn[s]||oo!==P.stOut[s]||od!==P.stDelay[s])stable=false;}' +
      'for(var r=0;r<net.R;r++){var rt=net.C.routes[r],re=net.rideEdge[r],mx=0;' +
      'for(var q=0;q<re.length;q++)if(P.load[re[q]]>mx)mx=P.load[re[q]];' +
      'var need=U.clamp(Math.max(mx/(rt.cap*mc.targetLF),serviceFloor(rt,p)),1,mc.fMax);' +
      'var of=P.freq[r];P.freq[r]=of*0.55+need*0.45;if(of!==P.freq[r])stable=false;' +
      'for(var q=0;q<re.length;q++){var e=re[q],LF=P.load[e]/Math.max(1,P.freq[r]*rt.cap),cf=1;' +
      'if(LF>0.6)cf=1+0.25*Math.min(1,(LF-0.6)/0.4);if(LF>1)cf=1.25+1.6*(LF-1);' +
      'var oc=P.crowd[e];P.crowd[e]=Math.min(3.5,oc*0.5+cf*0.5);if(oc!==P.crowd[e])stable=false;' +
      'if(LF>1)st.crowdPkm+=P.load[e]*net.eKm[e];}}}' +
      // 汽车分配
      'var nN=road.nN,nA=road.nA;' +
      'var rw={aux:new Float32Array(nA),dist:new Float64Array(nN),dkm:new Float32Array(nN),pred:new Int32Array(nN),order:new Int32Array(nN),accN:new Float64Array(nN)};' +
      'var cw={road:road,rd:roadData,time:P.arcTime,work:rw,heap:heap,skT:skT,skK:skK,carDem:carDem,Z:Zz};' +
      'var conn=roadData.start,zPop=S.zPop||null,fullSkim=!!S.fullSkim,iters=P.iters;' +
      'for(var o=0;o<Zz;o++){var c0=conn[o],c1=conn[o+1];if(c0===c1)continue;' +
      'if(!hasCar[o]&&!(fullSkim&&zPop&&zPop[o]>0)&&iters>0)continue;' +
      'if(!carOrigin(cw,o,stable))stable=false;}' +
      'var lam=P.iters===0?1:C.road.msa,bprA=C.road.bprA,capF=S.capF||1;' +
      'for(var a=0;a<nA;a++){var ov=P.arcVol[a],ot=P.arcTime[a],v=ov*(1-lam)+rw.aux[a]*lam;P.arcVol[a]=v;' +
      'var x=v/(road.arcCap[a]*capF);P.arcTime[a]=road.arcT0[a]*Math.min(8,1+bprA*x*x*x*x);' +
      'if(ov!==P.arcVol[a]||ot!==P.arcTime[a])stable=false;' +
      'st.congNum+=v*road.arcLen[a]*(P.arcTime[a]/road.arcT0[a]);st.congDen+=v*road.arcLen[a];}' +
      'P.iters++;' +
      'if(P.stats){var o2=P.stats;for(var k in st)if(o2[k]!==undefined)st[k]=o2[k]*0.4+st[k]*0.6;}' +
      'if(stable&&P.stats)for(var k in st)if(st[k]!==P.stats[k]){stable=false;break;}' +
      'P.stats=st;P.stable=stable;}' +
      // P 自己的数组
      'function allocP(P){var N=net?net.N:0,nE=net?net.nE:0,nA=road?road.nA:0,nN=road?road.nN:0;' +
      'if(!P.load||P.load.length!==nE)P.load=new Float32Array(nE);' +
      'if(!P.freq||P.freq.length!==(net?net.R:0))P.freq=new Float32Array(net?net.R:0);' +
      'if(!P.crowd||P.crowd.length!==nE){P.crowd=new Float32Array(nE).fill(1);}' +
      'if(!P.stIn||P.stIn.length!==N)P.stIn=new Float32Array(N);' +
      'if(!P.stOut||P.stOut.length!==N)P.stOut=new Float32Array(N);' +
      'if(!P.stBoard||P.stBoard.length!==N)P.stBoard=new Float32Array(N);' +
      'if(!P.stXfer||P.stXfer.length!==N)P.stXfer=new Float32Array(N);' +
      'if(!P.stDelay||P.stDelay.length!==N)P.stDelay=new Float32Array(N);' +
      'if(!P.arcVol||P.arcVol.length!==nA)P.arcVol=new Float32Array(nA);' +
      'if(!P.arcTime||P.arcTime.length!==nA)P.arcTime=new Float32Array(nA);' +
      'if(!P.skimT||P.skimT.length!==S.Z*S.Z)P.skimT=new Float32Array(S.Z*S.Z);' +
      'if(!P.skimK||P.skimK.length!==S.Z*S.Z)P.skimK=new Float32Array(S.Z*S.Z);' +
      'var F=S.NF;' +
      'if(!P.desTot||P.desTot.length!==S.B)P.desTot=new Float64Array(S.B);' +
      'if(!P.desMetro||P.desMetro.length!==S.B)P.desMetro=new Float64Array(S.B);' +
      'if(!P.zTrips||P.zTrips.length!==S.Z)P.zTrips=new Float64Array(S.Z);' +
      'if(!P.zMetro||P.zMetro.length!==S.Z)P.zMetro=new Float64Array(S.Z);' +
      'if(!P.zAccess||P.zAccess.length!==S.Z)P.zAccess=new Float64Array(S.Z);' +
      'if(!P.zDest||P.zDest.length!==6*S.Z)P.zDest=new Float64Array(6*S.Z);' +
      'if(!P.zDestM||P.zDestM.length!==6*S.Z)P.zDestM=new Float64Array(6*S.Z);' +
      'if(!P.fIn||P.fIn.length!==F)P.fIn=new Float64Array(F);' +
      'if(!P.fInM||P.fInM.length!==F)P.fInM=new Float64Array(F);' +
      'if(!P.fOut||P.fOut.length!==F)P.fOut=new Float64Array(F);' +
      'if(!P.fOutM||P.fOutM.length!==F)P.fOutM=new Float64Array(F);' +
      'if(!P.fP||P.fP.length!==6*F)P.fP=new Float64Array(6*F);}' +
      // 地铁最短路
      'function skim(net,P,p,prm){var N=net.N,nn=net.nNodes,nE=net.nE;' +
      'var cost=new Float32Array(nE),tAct=new Float32Array(nE);' +
      'for(var e=0;e<nE;e++){var ty=net.eType[e];' +
      'if(ty===0){var f=Math.max(0.5,P.freq[net.eRoute[e]]),w=60/(2*f);cost[e]=prm.waitW*w+prm.tpen+P.stDelay[net.eSt[e]];tAct[e]=w+P.stDelay[net.eSt[e]]*0.5;}' +
      'else if(ty===2){cost[e]=net.eT0[e]*P.crowd[e];tAct[e]=net.eT0[e];}' +
      'else if(ty===3){cost[e]=prm.walkW*net.eT0[e]+prm.opn;tAct[e]=net.eT0[e];}}' +
      'var store={N:N,nn:nn,gt:new Float32Array(N*N),tm:new Float32Array(N*N),km:new Float32Array(N*N),pred:new Int32Array(N*nn),order:new Int32Array(N*nn),nOrd:new Int32Array(N),D:new Float32Array(N*N)};' +
      'var work={cost:cost,tAct:tAct,dist:new Float64Array(nn),dtm:new Float32Array(nn),dkm:new Float32Array(nn)};' +
      'for(var s=0;s<N;s++)metroTree(net,cost,tAct,s,work,store,heap,prm.tpen);' +
      'return store;}' +
      // 整轮求解的一次请求（这里是 A 分支的入口）
      'function goRoad(m){net=m.net;road=m.road;roadData=m.roadData;S=m.stat;self.postMessage({t:"roadOk",id:m.id});}' +
      // 每日汇总：与主线程同一口径
      'function goDaily(m){var per=m.per,out={},ok=true,C=CFGX;' +
      'var D={trips:0,metro:0,car:0,timeSum:0,commTrips:0,commTime:0,fare:0,metroPkm:0,vkt:0,carPkm:0,congNum:0,congDen:0,crowdPkm:0,carKm:0,metroTime:0,carTime:0};' +
      'for(var p=0;p<per.length;p++){var P=per[p],s=P.stats;if(!s){ok=false;continue;}' +
      'var h=S.pHours[p],mf=p===3?0.9:1;' +
      'for(var k in s)D[k]=(D[k]||0)+s[k]*h*(m.metroKeys.indexOf(k)>=0?mf:1);' +
      'if(net&&net.R){for(var r=0;r<net.R;r++){var rt=net.C.routes[r],svcH=p===3?5:h;D.carKm+=P.freq[r]*2*(rt.lenM/1000)*rt.cars*svcH;}}}' +
      'self.postMessage({t:"dailyR",id:m.id,ok:ok,sum:D});}';
  }

  // B 多进程的 Worker 源码：池里每一片按角色只算自己那一段，汇总那一片负责并成一份状态。
  function workerSrcB() {
    return 'var INF=1e30;' +
      'var npk=6,PK=["hw","sc","sh","md","lz","hb"];' +
      'var U={dist:function(ax,ay,bx,by){var dx=bx-ax,dy=by-ay;return Math.sqrt(dx*dx+dy*dy);},clamp:function(v,a,b){return v<a?a:(v>b?b:v);}};' +
      'var odOrigin=(' + kernel + ');' +
      'var demandOrigin=(' + demKernel + ');' +
      'var odBuffer=(' + bufKernel + ');' +
      'var odGrow=(' + growKernel + ');' +
      'var carOrigin=(' + carKernel + ');' +
      'var roadTree=(' + roadKernel + ');' +
      'var metroLoadFrom=(' + loadKernel + ');' +
      'var metroTree=(' + treeKernel + ');' +
      'var serviceFloor=(' + svcKernel + ');' +
      'var OUT=' + JSON.stringify(OUT) + ',ACC=' + JSON.stringify(ACC) + ',CFGX=null,S=null,net=null,road=null,roadData=null;' +
      'var heap={n:0,key:[],val:[],lastKey:0,clear:function(){this.n=0;},push:function(k,v){var i=this.n++;' +
      'while(i>0){var p=(i-1)>>1;if(this.key[p]<=k)break;this.key[i]=this.key[p];this.val[i]=this.val[p];i=p;}this.key[i]=k;this.val[i]=v;},' +
      'pop:function(){var top=this.val[0],k=this.key[0],n=--this.n;this.lastKey=k;if(n>0){var kk=this.key[n],vv=this.val[n],i=0;for(;;){var l=i*2+1;if(l>=n)break;' +
      'var r=l+1,c=(r<n&&this.key[r]<this.key[l])?r:l;if(this.key[c]>=kk)break;this.key[i]=this.key[c];this.val[i]=this.val[c];i=c;}this.key[i]=kk;this.val[i]=vv;}return top;}};' +
      'self.onmessage=function(e){var m=e.data;if(!m)return;' +
      'if(m.t==="cfg"){CFGX=m.cfg;return;}' +
      'if(m.t==="stat"){S=m.stat;net=S.net||null;road=S.road||null;roadData=S.roadData||null;return;}' +
      'if(m.t==="demand"){goDemand(m);return;}' +
      'if(m.t==="traf"){goTraf(m);return;}' +
      'if(m.t==="metro"){goMetro(m);return;}' +
      'if(m.t==="road"){goRoad(m);return;}};' +
      // ---- 人口块：起点需求表这一段 ----
      'function goDemand(m){try{var D=m.D,d=demand(D,m.from,m.to);' +
      'self.postMessage({t:"demandR",id:m.id,cnts:d.cnts,dest:d.dest,t:d.t,tot:d.tot},[d.cnts.buffer,d.dest.buffer].concat(d.t.map(function(a){return a.buffer;})));}' +
      'catch(err){self.postMessage({t:"phaseErr",id:m.id,role:"pop",msg:String(err&&err.message||err)});}}' +
      'function demand(D,from,to){var Z=D.Z,F=D.F,per=D.per;var D2={},k;for(k in D)D2[k]=D[k];' +
      'var o=odBuffer((to-from)*per+64);D2.out=o;D2.n=0;D2.tot=new Float64Array(6);' +
      'D2.w=[new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z),new Float64Array(Z)];' +
      'D2.wf=[null,new Float64Array(F),new Float64Array(F),new Float64Array(F),new Float64Array(F)];' +
      'D2.scores=new Float64Array(Z);D2.s=new Float64Array(5);D2.kk=new Float64Array(5);' +
      'D2.cand=new Int32Array(Z);D2.candF=new Int32Array(F>0?F:1);' +
      'var cnts=new Int32Array(to-from);' +
      'for(var i=from;i<to;i++){if(o.cap-D2.n<per){o=odGrow(o,D2.n,Math.max(o.cap*2,D2.n+per*4));D2.out=o;}demandOrigin(D2,i);cnts[i-from]=D2.n;}' +
      'var dest=new Int32Array(D2.n);dest.set(o.dest.subarray(0,D2.n));' +
      'var t=[];for(var q=0;q<6;q++){var a=new Float32Array(D2.n);a.set(o.t[q].subarray(0,D2.n));t.push(a);}' +
      'return {cnts:cnts,dest:dest,t:t,tot:D2.tot};}' +
      // 退回主线程的包：带类型的数组都原样送，省一次拷贝
      'function trs(o){var tr=[];for(var k in o){var a=o[k];if(a&&a.buffer&&a.byteLength)tr.push(a.buffer);}return tr;}' +
      // 交通块：自己那段起点的方式选择，交出跨起点需要求和的部分
      'function goTraf(m){try{var Z=S.Z,NZ=S.NZ,N=net?net.N:0,F=S.NF;' +
      'var P={skimT:m.skT,skimK:m.skK,desTot:new Float64Array(S.B),desMetro:new Float64Array(S.B),' +
      'zTrips:new Float64Array(Z),zMetro:new Float64Array(Z),zAccess:new Float64Array(Z),' +
      'zDest:new Float64Array(6*Z),zDestM:new Float64Array(6*Z),' +
      'fIn:new Float64Array(F),fInM:new Float64Array(F),fOut:new Float64Array(F),fOutM:new Float64Array(F),fP:new Float64Array(6*F)};' +
      'var K={Z:Z,NZ:NZ,N:N,B:S.B,odStart:S.odStart,odDest:S.odDest,t0:S.t0,t1:S.t1,t2:S.t2,t3:S.t3,t4:S.t4,t5:S.t5,' +
      'co:m.co,cr:m.cr,cO:new Float64Array(npk),cR:new Float64Array(npk),facW:!!m.facW,facWe:S.facWe,odOk:true,' +
      'hostZ:S.hostZ,nx:S.nx,ny:S.ny,skT:m.skT,skK:m.skK,kmPerCell:S.kmPerCell,' +
      'cpk:S.cpk,park:S.park,vot:S.vot,carAccess:S.carAccess,walkW:S.walkW,occ:S.occ,theta:S.theta,fareFlat:S.fareFlat,' +
      'acc:m.acc,accOk:!!m.accOk,choices:new Int8Array(NZ*NZ).fill(-2),gtS:m.gtS,tmS:m.tmS,kmS:m.kmS,DS:m.DS,' +
      'perMin:S.perMin,capSh:S.capSh,capLz:S.capLz,carDem:new Float64Array(Z*Z),hasCar:new Uint8Array(Z),' +
      'totStat:new Float64Array(14),pT:new Float64Array(npk),pM:new Float64Array(npk),' +
      'zTrips:P.zTrips,zMetro:P.zMetro,zAccess:P.zAccess,zJ:S.zJ,blocks:S.blocks,desTot:P.desTot,desMetro:P.desMetro,' +
      'zDest:P.zDest,zDestM:P.zDestM,fIn:P.fIn,fInM:P.fInM,fOut:P.fOut,fOutM:P.fOutM,fP:P.fP};' +
      'var lt=new Float32Array(N),lf=new Float32Array(N),lc=new Float32Array(N);' +
      'for(var i=m.from;i<m.to;i++){odOrigin(K,i);var b=P.blocks[i];if(b<0)continue;lt[b]+=P.zTrips[i];lf[b]+=P.zMetro[i];lc[b]+=P.zAccess[i];}' +
      'var ts=K.totStat,acc=new Float64Array(26);' +
      'for(var q=0;q<14;q++)acc[q]=ts[q];for(var q=0;q<6;q++){acc[14+q]=K.pT[q];acc[20+q]=K.pM[q];}' +
      'var s={totStat:acc,zT:lt,zF:lf,zA:lc,desTot:P.desTot,desMetro:P.desMetro,' +
      'zDest:P.zDest,zDestM:P.zDestM,fIn:P.fIn,fInM:P.fInM,fOut:P.fOut,fOutM:P.fOutM,fP:P.fP};' +
      'self.postMessage({t:"trafR",id:m.id,set:s},trs(s));}' +
      'catch(err){self.postMessage({t:"phaseErr",id:m.id,role:"traf",msg:String(err&&err.message||err)});}}' +
      // 地铁块：客流加载 + 车站延误 + 自动配车
      'function goMetro(m){try{var lam=m.lam,N=net.N,e,nE=net.nE,nn=net.nNodes,R=net.R,mc=CFGX.metro;' +
      'var D=new Float32Array(N*N);D.set(m.DS);' +
      'var work={load:new Float32Array(nE),accN:new Float64Array(nn),stIn:new Float32Array(N),stOut:new Float32Array(N),stBoard:new Float32Array(N),walkIn:new Float32Array(N)};' +
      'var store={D:D,order:m.order,pred:m.pred,nOrd:m.nOrd,gt:m.gtS,tm:m.tmS,km:m.kmS};' +
      'for(var s=0;s<N;s++)metroLoadFrom(net,store,s,work);' +
      'var stB=work.stBoard,wIn=work.walkIn;' +
      'for(e=0;e<nE;e++){var ty=net.eType[e];if(ty===0)stB[net.eSt[e]]+=m.load[e];else if(ty===3)wIn[net.eSt[e]]+=m.load[e];}' +
      'var load2=new Float32Array(nE),stIn=new Float32Array(N),st2=new Float32Array(N),xf=new Float32Array(N),dl2=new Float32Array(N),bd=new Float32Array(N);' +
      'for(e=0;e<nE;e++)load2[e]=m.load[e]*(1-lam)+work.load[e]*lam;' +
      'for(var s=0;s<N;s++){stIn[s]=m.stIn[s]*(1-lam)+work.stIn[s]*lam;st2[s]=m.stOut[s]*(1-lam)+work.stOut[s]*lam;' +
      'bd[s]=stB[s];xf[s]=Math.max(0,stB[s]-stIn[s]-wIn[s]);' +
      'var cap=mc.stationCap[net.C.stations[s].size],ratio=(stIn[s]+st2[s]+xf[s])/cap,dl=U.clamp((ratio-0.8)*10,0,12);' +
      'dl2[s]=m.stDelay[s]*0.5+dl*0.5;}' +
      'var freq=new Float32Array(R),crowd=new Float32Array(nE);' +
      'for(e=0;e<nE;e++)crowd[e]=m.crowd[e];' +
      'for(var r=0;r<R;r++){var rt=net.C.routes[r],re=net.rideEdge[r],mx=0;' +
      'for(e=0;e<re.length;e++)if(load2[re[e]]>mx)mx=load2[re[e]];' +
      'var need=U.clamp(Math.max(mx/(rt.cap*mc.targetLF),serviceFloor(rt,m.p)),1,mc.fMax);' +
      'freq[r]=m.freq[r]*0.55+need*0.45;' +
      'for(e=0;e<re.length;e++){var a=re[e],LF=load2[a]/Math.max(1,freq[r]*rt.cap),cf=1;' +
      'if(LF>0.6)cf=1+0.25*Math.min(1,(LF-0.6)/0.4);if(LF>1)cf=1.25+1.6*(LF-1);' +
      'crowd[a]=Math.min(3.5,m.crowd[a]*0.5+cf*0.5);}}' +
      'var s2={load:load2,stIn:stIn,stOut:st2,stBoard:bd,stXfer:xf,stDelay:dl2,freq:freq,crowd:crowd};' +
      'self.postMessage({t:"phaseDone",id:m.id,role:"metro",set:s2},trs(s2));}' +
      'catch(err){self.postMessage({t:"phaseErr",id:m.id,role:"metro",msg:String(err&&err.message||err)});}}';
  }

  // 片数按设置项来；单进程固定一片
  function wantW() {
    if (!isMulti) return 1;
    let n = +threads || 0;
    if (!(n > 0)) {
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      n = Math.max(1, cores - 1);
    }
    return Math.max(1, Math.min(MAXT, n | 0));
  }

  // 出错的等待全部放开（传 null），调用方看到失败就回退串行，不会卡在等结果
  function onMsg(e, br) {
    const m = e.data;
    if (!m) return;
    const tbl = br === 'B' ? pend : pendA;
    if (m.t === 'solveErr' && m.msg) console.error('[SimPar] 单进程求解失败:', m.msg);
    if (m.t === 'phaseErr' && m.msg) console.error('[SimPar] 多进程某一块失败:', m.role, m.msg);
    if (m.t === 'demandR') { const p = tbl.get(m.id); if (p) { tbl.delete(m.id); p.res(m); } return; }
    if (m.t === 'trafR') { const p = tbl.get(m.id); if (p) { tbl.delete(m.id); p.res(m); } return; }
    if (m.t === 'phaseDone') {
      const p = tbl.get(m.id); if (p) { tbl.delete(m.id); p.res(m.set); }
      return;
    }
    if (m.t === 'demandA') { const p = tbl.get(m.id); if (p) { tbl.delete(m.id); p.res({ start: m.start, dest: m.dest, t: m.t, tot: m.tot }); } return; }
    if (m.t === 'solved') { const p = tbl.get(m.id); if (p) { tbl.delete(m.id); p.res({ per: m.per }); } return; }
    if (m.t === 'solveErr') { const p = tbl.get(m.id); if (p) { tbl.delete(m.id); p.res(null); } }
  }

  // 起点按累计需求均分（起点工作量差得很大，按个数平分会被人最重那片拖住）
  function splitByLoad(start, Z, n) {
    const list = [];
    if (!start || !(start.length > 0) || !(start[start.length - 1] > 0)) {
      const per = Math.ceil(Z / n);
      for (let w = 0; w < n; w++) {
        const lo = Math.min(Z, w * per), hi = Math.min(Z, (w + 1) * per);
        if (hi > lo) list.push({ lo: lo, hi: hi });
      }
      return list;
    }
    const total = start[start.length - 1];
    let lo = 0;
    for (let w = 0; w < n; w++) {
      let hi = Z;
      if (w < n - 1 && lo < Z) {
        const target = total * (w + 1) / n;
        const hiMax = Z - Math.min(n - w - 1, Z - lo - 1);
        let best = Infinity;
        hi = lo + 1;
        for (let i = lo + 1; i <= hiMax; i++) {
          const d = Math.abs(start[i] - target);
          if (d < best) { best = d; hi = i; }
        }
        if (hi <= lo) hi = lo + 1;
        if (hi > hiMax) hi = hiMax;
      }
      if (hi > lo) list.push({ lo: lo, hi: Math.min(hi, Z) });
      if (hi > lo) lo = Math.min(hi, Z);
    }
    return list;
  }

  // 等一片的回包；片里抛错或被关掉时回 null，调用方据此回退串行
  function ask(w, wid, msg) {
    if (!w) return Promise.resolve(null);
    return new Promise(function (res) {
      pend.set(wid, { res: res });
      send(w, msg);
    });
  }

  // 静态结构只在网络、道路或需求表真的换了才重送
  function sendStat(K) {
    const key = statKeyOf(K);
    if (statSent && key === statKey) return;
    statKey = key;
    statSent = true;
    const stat = packStat(K);
    for (const w of poolB) { try { w.postMessage({ t: 'stat', stat: stat }); } catch (e) {} }
  }

  // 需求表内容 + 网络是否在 + 道路规模，任何一项变了都要重送
  function statKeyOf(K) {
    const a = K.odStart, b = K.odDest;
    let h = 2166136261;
    const step = a.length > 4096 ? 7 : 1;
    for (let i = 0; i < a.length; i += step) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; }
    for (let i = 0; i < b.length; i += (b.length > 4096 ? 97 : 1)) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
    return a.length + ':' + b.length + ':' + h + ':' + (K.net ? K.net.N + '/' + K.net.R : '-') + ':' + (K.road ? K.road.nA : 0) + ':' + (K.roadData ? K.roadData.start.length : 0);
  }

  // 交给 Worker 的静态结构：网络、道路、需求表与一组固定参数
  function packStat(K) {
    const stat = { NF: K.NF, NZ: K.NZ, B: K.B };
    for (const k of STAT) if (K[k] !== undefined) stat[k] = K[k];
    for (const k of ODT) if (K[k] !== undefined) stat[k] = K[k];
    stat.net = K.net ? packNetOf(K.net) : null;
    stat.road = K.road || null;
    stat.roadData = K.roadData || null;
    stat.facWe = K.facWe || null;
    return stat;
  }

  function packNetOf(net) {
    if (!net) return null;
    return { N: net.N, nE: net.nE, R: net.R, nNodes: net.nNodes, eType: net.eType, eRoute: net.eRoute, eSt: net.eSt,
      eT0: net.eT0, eKm: net.eKm, eFrom: net.eFrom, outStart: net.outStart, outEdge: net.outEdge, eTo: net.eTo,
      rideEdge: net.rideEdge, boardEdge: net.boardEdge, routeKey: net.routeKey, C: net.C,
      acc: net.acc ? { NZ: net.acc.NZ, zCov: net.acc.zCov, zWalk: net.acc.zWalk } : null };
  }
  // B 多进程的一轮：人口块管需求表，地铁块管加载与调度，交通块按起点分担方式选择，最后并成一份状态。
  // 地铁块要用本轮的方式选择结果，所以它排在交通块后面起跑；交通块之间互不相干，可以真正并行。
  function run(K, Z, od, stable) {
    if (!kernel || !readyB()) return null;
    if (nWB < 2) return null;
    sendStat(K);
    const id = ++token;
    const NT = Math.max(1, nWB - 1);
    const parts = splitByLoad(K.odStart || (od && od.start), Z, NT);
    if (parts.length !== NT) return null;
    const waits = [];
    for (let w = 0; w < NT; w++) {
      const pt = parts[w];
      waits.push(pair(poolB[w], id + ':' + w, { t: 'traf', id: id + ':' + w, from: pt.lo, to: pt.hi,
        co: K.co, cr: K.cr, facW: K.facW, fullSkim: !!K.fullSkim, skT: K.skT, skK: K.skK,
        acc: K.acc || null, accOk: K.accOk, gtS: K.gtS, tmS: K.tmS, kmS: K.kmS, DS: K.DS }));
    }
    return Promise.all(waits).then(function (list) {
      const res = {};
      for (const it of list) { if (!it) return null; for (const k in it.set) { const a = it.set[k]; if (!a) continue; if (ACC.includes(k)) { if (!res[k]) res[k] = Float64Array.from(a); else for (let q = 0; q < a.length && q < res[k].length; q++) res[k][q] += a[q]; } else if (!res[k]) res[k] = a; } }
      // 分区量按小区编号对齐后相加（各段只写自己那几个小区）
      zsum(res.zT, K.zTrips); zsum(res.zF, K.zMetro); zsum(res.zA, K.zAccess);
      stitch(K, res);
      const wm = nWB - 1;
      if (!poolB[wm]) return Promise.resolve({ ok: true });
      return pair(poolB[wm], id + ':m', { t: 'metro', id: id + ':m', lam: K.metroLam || 0.5, p: K.taskHour,
        load: K.load, stIn: K.stIn, stOut: K.stOut, stDelay: K.stDelay, freq: K.freq, crowd: K.crowd }).then(function (it) {
        if (!it) return null;
        stitch(K, it.set);
        return { ok: true };
      });
    });
  }

  // 只等这一片自己那条回包
  function pair(w, wid, msg) {
    if (!w) return Promise.resolve(null);
    return new Promise(function (res) {
      pend.set(wid, { res: res });
      send(w, msg);
    });
  }

  // 各段起点的分区量按小区编号对齐后相加（每段只写自己那几个小区，其余为 0）
  function zsum(src, dst) {
    if (!src || !dst) return;
    for (let i = 0; i < dst.length && i < src.length; i++) dst[i] += src[i];
  }

  // 把各块算出的累加量并进模型那组数组（跨起点求和的，各段直接相加）
  function stitch(K, res) {
    for (const k of OUT) {
      const s = res[k], d = K[k];
      if (!s || !d) continue;
      for (let i = 0; i < d.length && i < s.length; i++) d[i] += s[i];
    }
  }

  // 需求表生成：各片各算自己那段起点，回来后按起点顺序拼成一块新缓冲
  function demand(D) {
    const Z = D.Z;
    if (!(Z > 0) || !readyB()) return null;
    // 需求表整张交给唯一那一片算完
    const w = poolB[0];
    if (!w) return null;
    const id = ++token;
    return new Promise(function (res) {
      pend.set(id + ':0', { res: res });
      send(w, { t: 'demandR', id: id + ':0', D: D, from: 0, to: Z });
    }).then(function (o) {
      if (!o || !o.dest) return null;
      const start = new Int32Array(Z + 1);
      for (let i = 0; i < Z; i++) start[i + 1] = start[i] + o.cnts[i];
      return { start: start, dest: o.dest, t: o.t, tot: o.tot };
    });
  }

  // A 单进程：一次请求算完整轮分配
  function solveAll(req, model) {
    if (!bootA()) return null;
    const id = ++token;
    const wid = id + ':0';
    const stat = packNet(model);
    stat.trips = req.trips || null;
    stat.prm = req.prm || null;
    stat.pHours = req.pHours || null;
    stat.fareFlat = req.fareFlat;
    stat.fullSkim = !!req.fullSkim;
    stat.capF = req.capF || 1;
    let payload;
    try {
      payload = {
        t: 'solve', id: wid, cycles: req.cycles, stat: stat,
        per: req.per.map(function (o) { return { dt: o.dt, p: o.p, iters: o.iters, arr: wrapPer(o.arr) }; })
      };
    } catch (e) { return null; }
    return new Promise(function (res) {
      pendA.set(wid, { res: res });
      send(poolA[0], payload);
    }).then(function (r) { return r && r.per ? { per: r.per } : null; });
  }

  // 主线程送出数组时带上类型，Worker 里按原类型还原
  function wrapPer(arr) {
    const o = {};
    for (const k in arr) {
      const a = arr[k];
      if (!a || !a.buffer) continue;
      o[k] = { k: KIN[a.constructor.name] || 'f32', d: a };
    }
    return o;
  }
  const KIN = { Float32Array: 'f32', Float64Array: 'f64', Int32Array: 'i32', Uint8Array: 'u8', Uint16Array: 'u16' };

  function send(w, m) {
    try { w.postMessage(m); }
    catch (e) {
      for (const tbl of [pend, pendA]) {
        const p = tbl.get(m.id);
        if (p) { tbl.delete(m.id); p.res(null); }
      }
    }
  }

  // 只有指定分支的池可用时才为 true，另一分支的池建好也不影响
  function ready() {
    if (!kernel) return false;
    return isMulti ? readyB() : readyA();
  }
  function readyA() { return deadA ? false : bootA(); }
  function readyB() { return deadB ? false : bootB(); }

  function stop() {
    closeA(); closeB();
    return true;
  }

  function closeA() {
    for (const w of poolA) { try { w.terminate(); } catch (e) {} }
    poolA = []; nWA = 0; srcA = null; idleA = 0;
  }

  function closeB() {
    for (const w of poolB) { try { w.terminate(); } catch (e) {} }
    poolB = []; nWB = 0; srcB = null; statKey = ''; statSent = false;
    statKey = '';
  }

  // 每片都挂上同一套回调；分支不同，等待表也不同
  function hook(w, idx, br) {
    w.onmessage = function (e) { onMsg(e, br); };
    // 片里抛错时这条 worker 就废了：挂在它身上的等待全部放开（传 null），
    // 让调用方看到失败并回退，否则整轮求解会一直卡在等结果。
    w.onerror = function (ev) {
      if (ev && ev.message) console.error('[SimPar] worker 错误:', ev.message, 'line', ev.lineno);
      if (br === 'B') deadB = true; else deadA = true;
      const tbl = br === 'B' ? pend : pendA;
      for (const [wid, p] of tbl) {
        const c = wid.lastIndexOf(':');
        if (+wid.slice(c + 1) === idx && p && p.res) { tbl.delete(wid); p.res(null); }
      }
    };
    return w;
  }

  // ---- 两个分支各建各的池 ----
  // A 单进程只用 poolA[0]，B 多进程用 poolB 里的若干片；切模式不互相推倒对方的池。
  let srcA = null, poolA = [], nWA = 0, deadA = false, idleA = 0;
  let srcB = null, poolB = [], nWB = 0, deadB = false, idleB = 0;

  function bootA() {
    if (deadA || !kernel) return false;
    if (srcA) return nWA > 0;
    if (!envOk()) { deadA = true; return false; }
    try { srcA = workerSrcA(); } catch (e) { deadA = true; return false; }
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([srcA], { type: 'text/javascript' }));
      poolA = [hook(new Worker(url), 0, 'A')];
      nWA = 1;
    } catch (e) { deadA = true; closeA(); return false; }
    finally { if (url) { try { URL.revokeObjectURL(url); } catch (e2) {} } }
    return nWA > 0;
  }

  function bootB() {
    if (deadB || !kernel) return false;
    if (srcB) {
      if (!pend.size && nWB !== wantW()) { closeB(); return bootB(); }
      return nWB > 0;
    }
    if (!envOk()) { deadB = true; return false; }
    try { srcB = workerSrcB(); } catch (e) { deadB = true; return false; }
    const want = wantW();
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([srcB], { type: 'text/javascript' }));
      for (let i = 0; i < want; i++) poolB.push(hook(new Worker(url), i, 'B'));
      nWB = poolB.length;
    } catch (e) { deadB = true; closeB(); return false; }
    finally { if (url) { try { URL.revokeObjectURL(url); } catch (e2) {} } }
    return nWB > 0;
  }

  function envOk() {
    return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && !!URL.createObjectURL;
  }
  let statSent = false;

  CM.SimPar = {
    // 源码变了就丢弃已建的池，下次 ready() 按新源码重建
    setKernel: function (f) {
      const K = f || {};
      const changed = (K.od !== undefined && K.od !== kernel) || (K.dem !== undefined && K.dem !== demKernel) ||
        (K.buf !== undefined && K.buf !== bufKernel) || (K.grow !== undefined && K.grow !== growKernel) ||
        (K.car !== undefined && K.car !== carKernel) || (K.road !== undefined && K.road !== roadKernel) ||
        (K.load !== undefined && K.load !== loadKernel) || (K.tree !== undefined && K.tree !== treeKernel) ||
        (K.svc !== undefined && K.svc !== svcKernel);
      if (K.od !== undefined) kernel = K.od;
      if (K.dem !== undefined) demKernel = K.dem;
      if (K.buf !== undefined) bufKernel = K.buf;
      if (K.grow !== undefined) growKernel = K.grow;
      if (K.car !== undefined) carKernel = K.car;
      if (K.road !== undefined) roadKernel = K.road;
      if (K.load !== undefined) loadKernel = K.load;
      if (K.tree !== undefined) treeKernel = K.tree;
      if (K.svc !== undefined) svcKernel = K.svc;
      if (changed) { closeA(); closeB(); }
    },
    // 模式选择：true 走 B 多进程，false 走 A 单进程。只丢掉旧分支的池，新分支下次 ready() 再建。
    setMode: function (multi) {
      multi = !!multi;
      if (multi === isMulti) return true;
      isMulti = multi;
      threads = 0;
      if (multi) { deadB = false; closeA(); } else { deadA = false; closeB(); }
      return true;
    },
    multi: function () { return isMulti; },
    ready: ready,
    run: run,
    demand: demand,
    // A 单进程：整套分配交给唯一的那个 Worker，一次请求算完带回来
    solveAll: solveAll,
    stop: stop,
    count: function () { return isMulti ? nWB : nWA; },
    setThreads: function (n) {
      n = Math.max(1, Math.min(MAXT, (+n | 0) || 2));
      if (n === threads) return true;
      threads = n;
      if (!srcB) return true;
      if (pend.size) return false;
      closeB();
      return isMulti ? bootB() : true;
    }
  };
})(window.CM);
