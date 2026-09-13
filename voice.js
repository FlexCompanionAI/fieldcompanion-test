/* FieldCompanionAI Voice Mode v2 — hands-free voice command engine.
   Requires the main app script globals:
   $, show, save, active, archive, settings, timerInt, openCall,
   logTx, renderVitals, renderTx, renderAlerts, renderArchive,
   nowT, vitalsLine, SR */
(function(){
"use strict";

/* ================= helpers ================= */
function norm(s){return String(s==null?"":s).toLowerCase().replace(/[^a-z0-9\s\/]/g," ").replace(/\s+/g," ").trim();}
function vStatus(t){var el=$("voice-status");if(el)el.textContent=t;}
function vHeard(t){var el=$("voice-transcript");if(el)el.textContent=t;}

/* ================= speech parsers ================= */
var NUMW={zero:0,oh:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,
twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,thousand:1000};
function wordsToNum(words){
  var total=0,cur=0,seen=false;
  for(var i=0;i<words.length;i++){
    var w=words[i];if(!(w in NUMW))return null;seen=true;var v=NUMW[w];
    if(v===100)cur=(cur||1)*100;
    else if(v===1000){cur=(cur||1)*1000;total+=cur;cur=0;}
    else cur+=v;
  }
  return seen?total+cur:null;
}
function parseSpokenNumber(text){
  var t=norm(text),dm=t.match(/\d+(\.\d+)?/);
  if(dm)return parseFloat(dm[0]);
  var words=t.split(" ").filter(function(w){return w in NUMW;});
  if(!words.length)return null;
  if(words.length>1&&words.every(function(w){return NUMW[w]<10;}))
    return parseInt(words.map(function(w){return NUMW[w];}).join(""),10); /* "one one two" -> 112 */
  if(words.length>=2&&NUMW[words[0]]<10){
    var rest=wordsToNum(words.slice(1));
    if(rest!==null&&rest<100)return NUMW[words[0]]*100+rest; /* "one twelve" -> 112 */
  }
  return wordsToNum(words);
}
function parseBP(text){
  var t=norm(text).replace(/over|slash|divided by|\bby\b/g,"/");
  var nums=t.match(/\d+(\.\d+)?/g);
  if(nums&&nums.length>=2)return{sys:parseFloat(nums[0]),dia:parseFloat(nums[1])};
  var parts=t.split("/");
  if(parts.length>=2){
    var a=parseSpokenNumber(parts[0]),b=parseSpokenNumber(parts[1]);
    if(a!=null&&b!=null)return{sys:a,dia:b};
  }
  return null;
}
function parseYesNo(text){
  var t=" "+norm(text)+" ";
  if(/ (yes|yeah|yep|yup|correct|right|affirmative|confirmed|do it|go ahead|send it|ok|okay|sure) /.test(t))return true;
  if(/ (no|nope|nah|wrong|incorrect|negative|cancel|don't|dont|not) /.test(t))return false;
  return null;
}
function parseSex(text){
  var t=norm(text);
  if(t.indexOf("female")>=0||t==="f")return "F";
  if(t.indexOf("male")>=0||t==="m")return "M";
  return null;
}
function parseAVPU(text){
  var t=norm(text);
  if(t.indexOf("unresponsive")>=0)return "Unresponsive";
  if(t.indexOf("alert")>=0)return "Alert";
  if(t.indexOf("voice")>=0||t.indexOf("verbal")>=0)return "Voice";
  if(t.indexOf("pain")>=0)return "Pain";
  return null;
}
function parseAirway(text){
  var t=norm(text).replace(/\s+/g,"");
  if(t.indexOf("patent")>=0)return "Patent";
  if(t.indexOf("opa")>=0)return "OPA";
  if(t.indexOf("npa")>=0)return "NPA";
  return null;
}
var CALLTYPES=["Medical","Trauma","MVA","Fall","Overdose","Cardiac","Respiratory","Other"];
function parseCallType(text){
  var t=norm(text);
  for(var i=0;i<CALLTYPES.length;i++){
    if(t.indexOf(CALLTYPES[i].toLowerCase())>=0)return CALLTYPES[i];
  }
  return null;
}
var KNOWNSYMP=["Chest pain","Difficulty breathing","Unresponsive","Bleeding","Fall","Overdose suspected","Stroke signs","Seizure"];
function parseSymptoms(text){
  var t=norm(text),found=[];
  KNOWNSYMP.forEach(function(s){if(t.indexOf(s.toLowerCase())>=0)found.push(s);});
  if(found.length)return found;
  var raw=String(text).trim();
  return raw.length>=2?[raw]:null;
}
function freeText(text,min){var r=String(text==null?"":text).trim();return r.length>=(min||2)?r:null;}

/* ================= voice state ================= */
var V={on:false,speaking:false,mode:"idle",flow:null,step:0,data:{},confirmCb:null};
var vrec=null;

function vSay(text,cb){
  if(!("speechSynthesis" in window)){vStatus(text);if(cb)setTimeout(cb,50);return;}
  V.speaking=true;
  if(vrec){try{vrec.abort();}catch(e){} vrec=null;}
  vStatus("Speaking…");
  vHeard("🔊 "+text);
  var done=false;
  function fin(){if(done)return;done=true;V.speaking=false;if(cb)cb();if(V.on)vStartRec();}
  var u=new SpeechSynthesisUtterance(text);
  u.lang="en-US";u.rate=1.05;
  u.onend=fin;u.onerror=fin;
  try{speechSynthesis.cancel();speechSynthesis.speak(u);}catch(e){fin();return;}
  setTimeout(function(){if(V.speaking)fin();},12000); /* safety */
}

function vStartRec(){
  if(!V.on||V.speaking||!SR)return;
  if(vrec)return;
  try{vrec=new SR();}catch(e){vrec=null;vStatus("Mic unavailable in this browser.");return;}
  vrec.lang="en-US";vrec.continuous=true;vrec.interimResults=true;
  vrec.onresult=function(e){
    var interim="";
    for(var i=e.resultIndex;i<e.results.length;i++){
      var tr=e.results[i][0].transcript;
      if(e.results[i].isFinal){vHandle(tr.trim());}
      else interim+=tr;
    }
    if(interim)vHeard("…"+interim);
  };
  vrec.onend=function(){vrec=null;if(V.on&&!V.speaking)setTimeout(function(){if(V.on&&!V.speaking)vStartRec();},250);};
  vrec.onerror=function(e){
    if(e.error==="not-allowed"||e.error==="service-not-allowed"){
      vStatus("Mic blocked — allow microphone access, then restart voice mode.");stopVoice();
    }
  };
  try{vrec.start();vStatus("Listening — say a command, or 'help'.");}catch(e){vrec=null;}
}

function startVoice(){
  if(V.on)return;
  if(!SR){vStatus("Voice recognition isn't available in this browser.");vSay("Voice recognition isn't available in this browser.");return;}
  V.on=true;V.mode="idle";V.flow=null;
  var b=$("btn-voice");if(b){b.textContent="🛑 STOP VOICE MODE";b.classList.remove("ok");b.classList.add("bad");}
  vSay("Voice mode on. Say 'start call' to begin, or 'help' for commands.",function(){vStartRec();});
}
function stopVoice(){
  V.on=false;V.mode="idle";V.flow=null;V.confirmCb=null;
  if(vrec){try{vrec.abort();}catch(e){} vrec=null;}
  if("speechSynthesis" in window){try{speechSynthesis.cancel();}catch(e){}}
  V.speaking=false;
  var b=$("btn-voice");if(b){b.textContent="🎤 START VOICE MODE";b.classList.add("ok");b.classList.remove("bad");}
  vStatus("Voice mode off.");
}

/* ================= dialog engine ================= */
function needActive(){vSay("No active call. Say 'start call' first.");}
function runFlow(flow){V.flow=flow;V.step=0;V.data={};V.mode="flow";vSay(flow.intro+" "+flow.slots[0].ask);}
function handleSlot(text){
  var f=V.flow,s=f.slots[V.step],t=norm(text);
  if(s.optional&&/^(skip|none|nope|pass|unknown)/.test(t)){V.data[s.key]=(s.def!=null?s.def:"");return advance();}
  var val=s.parse(text);
  if(val==null||val===""){vSay("I didn't catch that. "+s.ask);return;}
  V.data[s.key]=val;advance();
}
function advance(){
  V.step++;
  if(V.step>=V.flow.slots.length){
    var f=V.flow;V.flow=null;
    vSay(f.summary(V.data)+". Correct?",function(){
      V.mode="confirm";
      V.confirmCb=function(ok){
        V.mode="idle";V.confirmCb=null;
        if(ok){f.onDone(V.data);}
        else{vSay("Okay, let's redo it.",function(){runFlow(f);});}
      };
    });
    return;
  }
  vSay(V.flow.slots[V.step].ask);
}
function vAskConfirm(question,cb){
  vSay(question,function(){
    V.mode="confirm";
    V.confirmCb=function(ok){V.mode="idle";V.confirmCb=null;cb(ok);};
  });
}

function vHandle(text){
  if(!text||!V.on)return;
  vHeard("🎤 "+text);
  var t=norm(text);
  if(V.speaking)return;
  if(V.mode==="confirm"){
    var yn=parseYesNo(text);
    if(yn===true){var cb=V.confirmCb;V.confirmCb=null;V.mode="idle";if(cb)cb(true);}
    else if(yn===false){var cb2=V.confirmCb;V.confirmCb=null;V.mode="idle";if(cb2)cb2(false);}
    else vSay("Please say yes or no.");
    return;
  }
  if(V.mode==="txloop"){
    if(t.indexOf("done")>=0||t.indexOf("finished")>=0||t.indexOf("that's all")>=0){V.mode="idle";vSay("Interventions logged.");return;}
    logTx(String(text).trim());
    vSay("Logged: "+String(text).trim()+". Another? Say 'done' to finish.");
    return;
  }
  if(V.mode==="flow"){
    if(t.indexOf("cancel")>=0||t==="stop"){V.mode="idle";V.flow=null;vSay("Cancelled.");return;}
    if(t.indexOf("help")>=0){cmdHelp(true);return;}
    handleSlot(text);return;
  }
  /* idle: match a command */
  if(t.indexOf("cancel")>=0||t==="stop"){vSay("Nothing to cancel.");return;}
  matchCommand(t);
}

function matchCommand(t){
  var i,phrases;
  var C=[
    {p:["start call","begin call","new call"],fn:cmdStartCall},
    {p:["patient info","record patient","patient information"],fn:cmdPatient},
    {p:["record vitals","take vitals","log vitals","vital signs"],fn:cmdVitals},
    {p:["intervention","give medication","log treatment","medication"],fn:cmdTx},
    {p:["alert dispatch","send alert","dispatch alert","message squad"],fn:cmdAlert},
    {p:["call fire control","call fire"],fn:cmdFire},
    {p:["end call","finish call","close call"],fn:cmdEnd},
    {p:["read report","read back","read the report"],fn:cmdRead},
    {p:["help","what can i say","commands"],fn:function(){cmdHelp(false);}},
    {p:["stop listening","mic off","voice off"],fn:stopVoice}
  ];
  for(i=0;i<C.length;i++){
    phrases=C[i].p;
    for(var j=0;j<phrases.length;j++){
      if(t.indexOf(phrases[j])>=0){C[i].fn();return;}
    }
  }
  if(t.indexOf("vitals")>=0){cmdVitals();return;}
  vSay("I didn't recognize that command. Say 'help' to hear the commands.");
}

/* ================= commands ================= */
function cmdStartCall(){
  if(active){vSay("A call is already active.");return;}
  runFlow({
    intro:"Starting a new call.",
    slots:[
      {key:"type",ask:"What type of call?",parse:parseCallType},
      {key:"address",ask:"What is the location?",parse:function(x){return freeText(x,3);}}
    ],
    summary:function(d){return "Starting "+d.type+" call at "+d.address;},
    onDone:function(d){
      var dt=new Date();
      var cad="CAD-"+dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+String(dt.getDate()).padStart(2,"0")+"-"+String(Math.floor(Math.random()*900)+100);
      active={cadId:cad,type:d.type,address:d.address,startedAt:dt.toLocaleString(),startMs:Date.now(),phase:"scene",
        patient:{},vitals:[],tx:[],narrative:"",transport:[],alerts:[],dest:""};
      save();openCall();show("screen-voice");
      vSay("Call "+cad+" started. Say 'record patient info' when ready.");
    }
  });
}

function cmdPatient(){
  if(!active){needActive();return;}
  runFlow({
    intro:"Recording patient info.",
    slots:[
      {key:"age",ask:"Patient age?",parse:function(x){var n=parseSpokenNumber(x);return(n!=null&&n>=0&&n<=120)?String(Math.round(n)):null;}},
      {key:"sex",ask:"Male or female?",parse:parseSex},
      {key:"avpu",ask:"A V P U: alert, voice, pain, or unresponsive?",parse:parseAVPU},
      {key:"airway",ask:"Airway: patent, O P A, or N P A?",parse:parseAirway},
      {key:"symptoms",ask:"Symptoms?",parse:parseSymptoms},
      {key:"notes",ask:"Any notes? Say 'skip' to skip.",parse:function(x){return freeText(x,2);},optional:true,def:""}
    ],
    summary:function(d){
      return "Patient: "+d.age+" year old "+(d.sex==="M"?"male":"female")+", "+d.avpu+", airway "+d.airway+", "+d.symptoms.join(", ")+(d.notes?". Notes: "+d.notes:"");
    },
    onDone:function(d){
      active.patient={age:d.age,sex:d.sex,avpu:d.avpu,airway:d.airway,symptoms:d.symptoms,notes:d.notes};
      save();
      vSay("Patient info saved.");
    }
  });
}

function speakVitals(d){
  var s="Heart rate "+d.hr+", blood pressure "+d.bps+" over "+d.bpd+", S P O 2 "+d.spo2+" percent, respiratory rate "+d.rr;
  if(d.bgl)s+=", blood sugar "+d.bgl;
  s+=", G C S "+(d.gcse+d.gcsv+d.gcsm);
  if(d.pain!=="")s+=", pain "+d.pain+" of 10";
  if(d.ecg)s+=", "+d.ecg;
  return s;
}
function cmdVitals(){
  if(!active){needActive();return;}
  var range=function(lo,hi){return function(x){var n=parseSpokenNumber(x);return(n!=null&&n>=lo&&n<=hi)?Math.round(n):null;};}
  runFlow({
    intro:"Recording vitals.",
    slots:[
      {key:"hr",ask:"Heart rate?",parse:range(20,250)},
      {key:"bp",ask:"Blood pressure? Say like: 120 over 80.",parse:parseBP},
      {key:"spo2",ask:"Oxygen saturation?",parse:range(40,100)},
      {key:"rr",ask:"Respiratory rate?",parse:range(4,80)},
      {key:"bgl",ask:"Blood sugar? Say 'skip' to skip.",parse:range(20,999),optional:true,def:""},
      {key:"gcse",ask:"G C S eyes, 1 to 4?",parse:range(1,4)},
      {key:"gcsv",ask:"G C S verbal, 1 to 5?",parse:range(1,5)},
      {key:"gcsm",ask:"G C S motor, 1 to 6?",parse:range(1,6)},
      {key:"pain",ask:"Pain, 0 to 10? Say 'skip' to skip.",parse:range(0,10),optional:true,def:""},
      {key:"ecg",ask:"E C G rhythm? Say 'skip' to skip.",parse:function(x){return freeText(x,2);},optional:true,def:""}
    ],
    summary:function(d){
      return speakVitals({hr:d.hr,bps:d.bp.sys,bpd:d.bp.dia,spo2:d.spo2,rr:d.rr,bgl:d.bgl,
        gcse:d.gcse,gcsv:d.gcsv,gcsm:d.gcsm,pain:d.pain,ecg:d.ecg});
    },
    onDone:function(d){
      var set={t:nowT(),
        gcs:(d.gcse+d.gcsv+d.gcsm)+" (E"+d.gcse+" V"+d.gcsv+" M"+d.gcsm+")",
        hr:String(d.hr),bps:String(d.bp.sys),bpd:String(d.bp.dia),spo2:String(d.spo2),
        rr:String(d.rr),bgl:String(d.bgl),ecg:d.ecg,pain:String(d.pain),phase:active.phase};
      active.vitals.push(set);save();renderVitals();renderTx();
      vSay("Vitals logged at "+set.t+".");
    }
  });
}

function cmdTx(){
  if(!active){needActive();return;}
  vSay("What intervention was given? Say each one, then say 'done' when finished.",function(){V.mode="txloop";});
}

function cmdAlert(){
  if(!active){needActive();return;}
  runFlow({
    intro:"Composing dispatch alert.",
    slots:[{key:"msg",ask:"What is the message?",parse:function(x){return freeText(x,3);}}],
    summary:function(d){return "Message: "+d.msg+". Send it";},
    onDone:function(d){
      active.alerts.push({t:nowT(),msg:d.msg});save();renderAlerts();
      vAskConfirm("Alert logged. Send by text message?",function(ok){
        if(!ok){vSay("Alert logged. You can paste it into IamResponding.");return;}
        var nums=String(settings.numbers||"").split(",").map(function(s){return s.trim();}).filter(Boolean);
        if(nums.length){window.location.href="sms:"+nums.join(",")+"?&body="+encodeURIComponent(d.msg);}
        else vSay("No squad numbers saved. Alert is logged — paste it into IamResponding.");
      });
    }
  });
}

function cmdFire(){
  refreshFireCtrl();
  var href=$("btn-firectrl").href,pretty=href.replace("tel:+1","").replace("tel:+","");
  vAskConfirm("Call Fire Control at "+pretty+" now?",function(ok){
    if(ok){window.location.href=href;}
    else vSay("Okay, not calling.");
  });
}

function cmdEnd(){
  if(!active){vSay("No active call.");return;}
  vAskConfirm("End the call and archive it?",function(ok){
    if(!ok){vSay("Call continues.");return;}
    active.endedAt=new Date().toLocaleString();active.phase="closed";
    archive.unshift(active);active=null;save();clearInterval(timerInt);
    renderArchive();show("screen-voice");
    vSay("Call ended and archived.");
  });
}

function cmdRead(){
  if(!active){vSay("No active call.");return;}
  var c=active,p=c.patient||{},parts=[];
  parts.push("Call "+c.cadId+", "+c.type+" at "+(c.address||"unknown location")+".");
  if(p.age)parts.push("Patient: "+p.age+" year old "+(p.sex==="M"?"male":"female")+".");
  c.vitals.forEach(function(s,i){parts.push("Vitals set "+(i+1)+": "+vitalsLine(s)+".");});
  c.tx.forEach(function(t){parts.push(t.t+": "+t.label+".");});
  if(!c.vitals.length&&!c.tx.length)parts.push("Nothing logged yet.");
  vSay(parts.join(" "));
}

function cmdHelp(inFlow){
  vSay("Commands are: start call. Record patient info. Record vitals. Interventions given. Alert dispatch. Call fire control. Read report. End call. Say 'cancel' any time to stop what you're doing.",
    function(){if(inFlow&&V.flow){V.mode="flow";vSay(V.flow.slots[V.step].ask);}});
}

/* ================= wiring ================= */
function wireVoice(){
  var gv=$("btn-goto-voice");
  if(gv)gv.onclick=function(){show("screen-voice");};
  var bv=$("btn-voice");
  if(bv)bv.onclick=function(){if(V.on)stopVoice();else startVoice();};
  var bb=$("btn-voice-back");
  if(bb)bb.onclick=function(){stopVoice();show("screen-home");};
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wireVoice);
else wireVoice();

/* test hooks */
window.VC={V:V,handle:vHandle,start:startVoice,stop:stopVoice,say:vSay,
  parseSpokenNumber:parseSpokenNumber,parseBP:parseBP,parseYesNo:parseYesNo,
  parseAVPU:parseAVPU,parseAirway:parseAirway,parseSex:parseSex,parseCallType:parseCallType};

})();
