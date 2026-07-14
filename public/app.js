const state={token:localStorage.getItem('chatToken')||'',user:null,socket:null,conversations:[],active:null,messages:[],uploads:[],typingTimer:null,uploadConfig:{maxUploadBytes:100*1024*1024,maxFilesPerBatch:10}};
const $=id=>document.getElementById(id);
function api(path,options={}){return fetch(path,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(state.token?{Authorization:`Bearer ${state.token}`}:{}) ,...(options.headers||{})}}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||`Error ${r.status}`);return d})}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function formatBytes(bytes){const n=Number(bytes||0);if(n<1024)return`${n} B`;if(n<1024*1024)return`${(n/1024).toFixed(1)} KB`;return`${(n/1024/1024).toFixed(1)} MB`}
function showApp(){$('loginView').classList.add('hidden');$('appView').classList.remove('hidden');$('userLabel').textContent=`${state.user.name} · ${state.user.role}`}
function logout(){localStorage.removeItem('chatToken');location.reload()}
async function bootstrap(){if(!state.token)return;try{const d=await api('/api/me');state.user=d.user;showApp();connectSocket();await Promise.all([loadConversations(),loadUploadConfig()])}catch{logout()}}
async function loadUploadConfig(){try{const d=await api('/api/upload/config');state.uploadConfig=d}catch{}}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginStatus').textContent='Entrando...';try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({code:$('codeInput').value.trim()})});state.token=d.token;state.user=d.user;localStorage.setItem('chatToken',d.token);$('loginStatus').textContent='';showApp();connectSocket();await Promise.all([loadConversations(),loadUploadConfig()])}catch(err){$('loginStatus').textContent=err.message}})
$('logoutBtn').onclick=logout;
async function loadConversations(){const d=await api('/api/conversations');state.conversations=d.conversations;renderConversations()}
function renderConversations(){const q=$('conversationSearch').value.toLowerCase();$('conversationList').innerHTML=state.conversations.filter(c=>c.name.toLowerCase().includes(q)).map(c=>`<div class="conversation ${state.active?.id===c.id?'active':''}" data-id="${c.id}"><div class="conversation-top"><strong>${escapeHtml(c.name)}</strong><small>${c.last_message_at?new Date(c.last_message_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''}</small></div><p>${escapeHtml(c.last_message||c.department||c.type)}</p></div>`).join('');document.querySelectorAll('.conversation').forEach(el=>el.onclick=()=>openConversation(el.dataset.id))}
$('conversationSearch').oninput=renderConversations;
async function openConversation(id){state.active=state.conversations.find(c=>c.id===id);$('conversationTitle').textContent=state.active.name;$('composer').classList.remove('hidden');$('appView').classList.add('chat-open');renderConversations();state.socket?.emit('conversation:join',{conversationId:id});const d=await api(`/api/conversations/${id}/messages`);state.messages=d.messages;renderMessages()}
function attachmentHtml(m){if(!m.attachment_url)return'';const url=escapeHtml(m.attachment_url);if(m.message_type==='image')return`<button class="media-open" data-type="image" data-url="${url}"><img src="${url}" alt="imagen" loading="lazy"></button>`;if(m.message_type==='video')return`<video controls preload="metadata" src="${url}"></video>`;if(m.message_type==='audio')return`<audio controls preload="metadata" src="${url}"></audio>`;return`<a class="file-card" target="_blank" rel="noopener" href="${url}"><span>📎</span><div><strong>${escapeHtml(m.attachment_name||'Archivo')}</strong><small>${formatBytes(m.attachment_size)}</small></div></a>`}
function renderMessages(){const list=$('messageList');list.innerHTML=state.messages.map(m=>`<article class="message ${m.sender_id===state.user.id?'mine':''}">${m.sender_id!==state.user.id?`<div class="message-name">${escapeHtml(m.sender_name||'Usuario')}</div>`:''}${attachmentHtml(m)}${m.body?`<div class="message-body">${escapeHtml(m.body)}</div>`:''}<div class="message-time">${new Date(m.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div></article>`).join('');list.querySelectorAll('.media-open').forEach(btn=>btn.onclick=()=>openViewer(btn.dataset.type,btn.dataset.url));list.scrollTop=list.scrollHeight}
function connectSocket(){if(state.socket)return;state.socket=io({auth:{token:state.token}});state.socket.on('message:new',m=>{const c=state.conversations.find(x=>x.id===m.conversation_id);if(c){c.last_message=m.body||m.attachment_name||'Archivo';c.last_message_at=m.created_at;renderConversations()}if(state.active?.id===m.conversation_id&&!state.messages.some(x=>x.id===m.id)){state.messages.push(m);renderMessages()}});state.socket.on('typing:update',e=>{if(e.conversationId!==state.active?.id||e.userId===state.user.id)return;$('typingLabel').textContent=e.typing?`${e.name} está escribiendo...`:''});state.socket.on('connect_error',e=>console.warn(e.message))}
$('messageInput').addEventListener('input',()=>{if(!state.active||!state.socket)return;state.socket.emit('typing:start',{conversationId:state.active.id});clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>state.socket.emit('typing:stop',{conversationId:state.active.id}),700)})
function sendSocketMessage(body,attachment){return new Promise((resolve,reject)=>{state.socket.emit('message:send',{conversationId:state.active.id,body,attachment},r=>r?.ok?resolve(r):reject(new Error(r?.message||'No se pudo enviar')))} )}
$('composer').addEventListener('submit',async e=>{e.preventDefault();if(!state.active)return;const body=$('messageInput').value.trim();const ready=state.uploads.filter(x=>x.status==='ready');if(!body&&!ready.length)return;const btn=e.submitter;btn.disabled=true;try{if(ready.length){for(let i=0;i<ready.length;i++){await sendSocketMessage(i===0?body:'',ready[i].attachment)}}else{await sendSocketMessage(body,null)}$('messageInput').value='';state.uploads=[];renderUploadQueue();state.socket.emit('typing:stop',{conversationId:state.active.id})}catch(err){$('uploadStatus').textContent=err.message}finally{btn.disabled=false}})
function chooseFiles(files){const list=[...files];if(!list.length)return;const available=Math.max(0,state.uploadConfig.maxFilesPerBatch-state.uploads.length);if(list.length>available){$('uploadStatus').textContent=`Máximo ${state.uploadConfig.maxFilesPerBatch} archivos por envío`}list.slice(0,available).forEach(file=>{if(file.size>state.uploadConfig.maxUploadBytes){$('uploadStatus').textContent=`${file.name} supera ${formatBytes(state.uploadConfig.maxUploadBytes)}`;return}state.uploads.push({id:crypto.randomUUID(),file,status:'pending',progress:0,error:'',attachment:null,preview:file.type.startsWith('image/')||file.type.startsWith('video/')?URL.createObjectURL(file):''})});renderUploadQueue();uploadPending()}
function renderUploadQueue(){const box=$('mediaQueue');if(!state.uploads.length){box.classList.add('hidden');box.innerHTML='';return}box.classList.remove('hidden');box.innerHTML=state.uploads.map(item=>`<div class="upload-item" data-id="${item.id}">${item.preview?(item.file.type.startsWith('video/')?`<video src="${item.preview}" muted></video>`:`<img src="${item.preview}" alt="preview">`):`<div class="file-icon">📎</div>`}<div class="upload-info"><strong>${escapeHtml(item.file.name)}</strong><small>${formatBytes(item.file.size)} · ${item.status==='ready'?'Listo':item.status==='error'?'Error':item.status==='uploading'?`Subiendo ${item.progress}%`:'En cola'}</small><div class="progress"><span style="width:${item.progress}%"></span></div>${item.error?`<em>${escapeHtml(item.error)}</em>`:''}</div><div class="upload-actions">${item.status==='error'?`<button data-action="retry">↻</button>`:''}<button data-action="remove">×</button></div></div>`).join('');box.querySelectorAll('.upload-item').forEach(el=>{el.querySelector('[data-action="remove"]').onclick=()=>removeUpload(el.dataset.id);const retry=el.querySelector('[data-action="retry"]');if(retry)retry.onclick=()=>retryUpload(el.dataset.id)})}
function removeUpload(id){const item=state.uploads.find(x=>x.id===id);if(item?.preview)URL.revokeObjectURL(item.preview);state.uploads=state.uploads.filter(x=>x.id!==id);renderUploadQueue()}
function retryUpload(id){const item=state.uploads.find(x=>x.id===id);if(!item)return;item.status='pending';item.error='';item.progress=0;renderUploadQueue();uploadPending()}
let uploading=false;async function uploadPending(){if(uploading)return;uploading=true;try{for(const item of state.uploads){if(item.status!=='pending')continue;item.status='uploading';renderUploadQueue();try{item.attachment=await uploadFile(item);item.status='ready';item.progress=100}catch(err){item.status='error';item.error=err.message}renderUploadQueue()}}finally{uploading=false}}
function uploadFile(item){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/upload');xhr.setRequestHeader('Authorization',`Bearer ${state.token}`);xhr.upload.onprogress=e=>{if(e.lengthComputable){item.progress=Math.round(e.loaded/e.total*100);renderUploadQueue()}};xhr.onload=()=>{let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300&&d.ok)resolve(d.attachment);else reject(new Error(d.message||`Error ${xhr.status}`))};xhr.onerror=()=>reject(new Error('Se perdió la conexión durante la subida'));const fd=new FormData();fd.append('file',item.file);xhr.send(fd)})}
['cameraInput','mediaInput','documentInput'].forEach(id=>$(id).addEventListener('change',e=>{chooseFiles(e.target.files);e.target.value='';$('attachMenu').classList.add('hidden')}));
$('attachMenuBtn').onclick=()=>{if(!state.active)return;$('attachMenu').classList.toggle('hidden')};document.addEventListener('click',e=>{if(!$('attachMenu').contains(e.target)&&e.target!==$('attachMenuBtn'))$('attachMenu').classList.add('hidden')});
function openViewer(type,url){$('viewerContent').innerHTML=type==='image'?`<img src="${escapeHtml(url)}" alt="imagen">`:`<video controls autoplay src="${escapeHtml(url)}"></video>`;$('mediaViewer').classList.remove('hidden')}
function closeViewer(){$('mediaViewer').classList.add('hidden');$('viewerContent').innerHTML=''}$('closeViewer').onclick=closeViewer;$('mediaViewer').onclick=e=>{if(e.target===$('mediaViewer'))closeViewer()};
$('backBtn').onclick=()=>$('appView').classList.remove('chat-open');$('callBtn').onclick=()=>alert('Las llamadas se agregarán con LiveKit después de estabilizar mensajes y multimedia.');

// =========================================================
// GRABADOR DE AUDIO TIPO WHATSAPP
// Al tocar Enviar, el audio se sube y se manda automáticamente.
// =========================================================
const recorderState={
  audioRecorder:null,
  audioStream:null,
  audioChunks:[],
  audioStartedAt:0,
  audioTimerId:null,
  audioCancelled:false,
  audioSending:false
};

function formatTimer(ms){
  const total=Math.max(0,Math.floor(ms/1000));
  const minutes=String(Math.floor(total/60)).padStart(2,'0');
  const seconds=String(total%60).padStart(2,'0');
  return `${minutes}:${seconds}`;
}

function bestAudioMime(){
  const candidates=[
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus'
  ];
  return candidates.find(type=>window.MediaRecorder?.isTypeSupported?.(type))||'';
}

function extensionForMime(mime,fallback='webm'){
  if(String(mime).includes('mp4'))return'm4a';
  if(String(mime).includes('ogg'))return'ogg';
  if(String(mime).includes('webm'))return'webm';
  return fallback;
}

function stopTracks(stream){
  stream?.getTracks?.().forEach(track=>track.stop());
}

async function uploadAndSendRecordedAudio(file){
  if(!state.active)throw new Error('Abre una conversación primero');

  const item={
    id:crypto.randomUUID(),
    file,
    status:'uploading',
    progress:0,
    error:'',
    attachment:null,
    preview:''
  };

  state.uploads.push(item);
  renderUploadQueue();
  $('uploadStatus').textContent='Enviando audio...';

  try{
    item.attachment=await uploadFile(item);
    item.status='ready';
    item.progress=100;
    renderUploadQueue();

    await sendSocketMessage('',item.attachment);

    state.uploads=state.uploads.filter(x=>x.id!==item.id);
    renderUploadQueue();
    $('uploadStatus').textContent='';
  }catch(error){
    item.status='error';
    item.error=error.message||'No se pudo enviar el audio';
    renderUploadQueue();
    $('uploadStatus').textContent=item.error;
    throw error;
  }
}

async function startAudioRecording(){
  if(!state.active||recorderState.audioSending)return;

  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){
    $('uploadStatus').textContent='Este navegador no permite grabar audio directamente.';
    return;
  }

  try{
    recorderState.audioStream=await navigator.mediaDevices.getUserMedia({
      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true,
        channelCount:1,
        sampleRate:{ideal:48000}
      }
    });

    recorderState.audioChunks=[];
    const mime=bestAudioMime();
    const options=mime
      ?{mimeType:mime,audioBitsPerSecond:128000}
      :{audioBitsPerSecond:128000};

    recorderState.audioRecorder=new MediaRecorder(recorderState.audioStream,options);

    recorderState.audioRecorder.ondataavailable=e=>{
      if(e.data?.size)recorderState.audioChunks.push(e.data);
    };

    recorderState.audioRecorder.onstop=async()=>{
      clearInterval(recorderState.audioTimerId);

      const recorder=recorderState.audioRecorder;
      const actualMime=recorder?.mimeType||mime||'audio/webm';
      const blob=new Blob(recorderState.audioChunks,{type:actualMime});

      stopTracks(recorderState.audioStream);
      recorderState.audioStream=null;
      recorderState.audioRecorder=null;
      recorderState.audioChunks=[];
      $('audioRecorderBar').classList.add('hidden');

      if(recorderState.audioCancelled||!blob.size){
        recorderState.audioCancelled=false;
        recorderState.audioSending=false;
        $('finishAudioBtn').disabled=false;
        return;
      }

      const ext=extensionForMime(actualMime);
      const file=new File(
        [blob],
        `audio-${Date.now()}.${ext}`,
        {type:actualMime,lastModified:Date.now()}
      );

      try{
        await uploadAndSendRecordedAudio(file);
      }finally{
        recorderState.audioSending=false;
        $('finishAudioBtn').disabled=false;
      }
    };

    recorderState.audioCancelled=false;
    recorderState.audioSending=false;
    recorderState.audioStartedAt=Date.now();
    recorderState.audioRecorder.start(250);

    $('audioRecorderBar').classList.remove('hidden');
    $('audioTimer').textContent='00:00';

    recorderState.audioTimerId=setInterval(()=>{
      $('audioTimer').textContent=formatTimer(
        Date.now()-recorderState.audioStartedAt
      );
    },250);
  }catch(error){
    $('uploadStatus').textContent=error?.name==='NotAllowedError'
      ?'Permite acceso al micrófono en Safari para grabar audio.'
      :(error.message||'No se pudo abrir el micrófono');
  }
}

function finishAudioRecording(cancel=false){
  const recorder=recorderState.audioRecorder;
  if(!recorder||recorder.state==='inactive')return;

  recorderState.audioCancelled=cancel;
  recorderState.audioSending=!cancel;

  if(!cancel){
    $('finishAudioBtn').disabled=true;
    $('uploadStatus').textContent='Preparando audio...';
  }

  recorder.stop();
}


// Experiencia de audio tipo WhatsApp:
// mantener presionado para grabar, soltar para enviar,
// deslizar a la izquierda para cancelar y hacia arriba para bloquear.
let voiceGesture={
  active:false,
  locked:false,
  startX:0,
  startY:0,
  pointerId:null,
  starting:false
};

async function beginVoiceGesture(event){
  if(!state.active||recorderState.audioSending||voiceGesture.starting)return;
  voiceGesture.starting=true;
  voiceGesture.active=true;
  voiceGesture.locked=false;
  voiceGesture.pointerId=event.pointerId;
  voiceGesture.startX=event.clientX;
  voiceGesture.startY=event.clientY;

  try{
    $('voiceRecordBtn').setPointerCapture?.(event.pointerId);
    await startAudioRecording();
  }finally{
    voiceGesture.starting=false;
  }
}

function moveVoiceGesture(event){
  if(!voiceGesture.active||voiceGesture.locked)return;
  const dx=event.clientX-voiceGesture.startX;
  const dy=event.clientY-voiceGesture.startY;

  if(dx<-85){
    voiceGesture.active=false;
    finishAudioRecording(true);
    $('uploadStatus').textContent='Audio cancelado';
    return;
  }

  if(dy<-85){
    voiceGesture.locked=true;
    $('audioRecorderBar').classList.add('locked');
    $('uploadStatus').textContent='Grabación bloqueada. Toca Enviar cuando termines.';
  }
}

function endVoiceGesture(){
  if(!voiceGesture.active)return;
  voiceGesture.active=false;
  if(!voiceGesture.locked){
    finishAudioRecording(false);
  }
}

const voiceButton=$('voiceRecordBtn');
voiceButton.onpointerdown=event=>{
  event.preventDefault();
  beginVoiceGesture(event);
};
voiceButton.onpointermove=moveVoiceGesture;
voiceButton.onpointerup=endVoiceGesture;
voiceButton.onpointercancel=()=>{
  if(voiceGesture.active&&!voiceGesture.locked){
    voiceGesture.active=false;
    finishAudioRecording(true);
  }
};
voiceButton.onclick=event=>event.preventDefault();

$('finishAudioBtn').onclick=()=>{
  voiceGesture.active=false;
  voiceGesture.locked=false;
  $('audioRecorderBar').classList.remove('locked');
  finishAudioRecording(false);
};
$('cancelAudioBtn').onclick=()=>{
  voiceGesture.active=false;
  voiceGesture.locked=false;
  $('audioRecorderBar').classList.remove('locked');
  finishAudioRecording(true);
};

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
}
bootstrap();
