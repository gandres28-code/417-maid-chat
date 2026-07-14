const state={
  token:localStorage.getItem('chatToken')||'',
  user:null,
  socket:null,
  conversations:[],
  active:null,
  messages:[],
  uploads:[],
  typingTimer:null,
  uploadConfig:{maxUploadBytes:100*1024*1024,maxFilesPerBatch:10},
  replyTo:null,
  reactionTarget:null,
  onlineUsers:new Set(),
  aiActions:[],
  aiFilter:'pending',
  unreadWhileScrolled:0,
  forceScrollOnNextRender:false
};
const $=id=>document.getElementById(id);
function api(path,options={}){return fetch(path,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(state.token?{Authorization:`Bearer ${state.token}`}:{}) ,...(options.headers||{})}}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||`Error ${r.status}`);return d})}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function formatBytes(bytes){const n=Number(bytes||0);if(n<1024)return`${n} B`;if(n<1024*1024)return`${(n/1024).toFixed(1)} KB`;return`${(n/1024/1024).toFixed(1)} MB`}
function isAdmin(){
  return ['admin','manager','owner','company owner','operations','dispatch'].includes(String(state.user?.role||'').toLowerCase());
}

function showApp(){
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userLabel').textContent=`${state.user.name} · ${state.user.role}`;
  $('aiPanel').classList.toggle('hidden',!isAdmin());
  if(isAdmin())loadAiActions();
}
function logout(){localStorage.removeItem('chatToken');location.reload()}
async function bootstrap(){if(!state.token)return;try{const d=await api('/api/me');state.user=d.user;showApp();connectSocket();await Promise.all([loadConversations(),loadUploadConfig()])}catch{logout()}}
async function loadUploadConfig(){try{const d=await api('/api/upload/config');state.uploadConfig=d}catch{}}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginStatus').textContent='Entrando...';try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({code:$('codeInput').value.trim()})});state.token=d.token;state.user=d.user;localStorage.setItem('chatToken',d.token);$('loginStatus').textContent='';showApp();connectSocket();await Promise.all([loadConversations(),loadUploadConfig()])}catch(err){$('loginStatus').textContent=err.message}})
$('logoutBtn').onclick=logout;
async function loadConversations(){const d=await api('/api/conversations');state.conversations=d.conversations;renderConversations()}
function renderConversations(){
  const q=$('conversationSearch').value.toLowerCase();
  $('conversationList').innerHTML=state.conversations
    .filter(c=>c.name.toLowerCase().includes(q))
    .map(c=>{
      const online=c.employee_owner_id&&state.onlineUsers.has(String(c.employee_owner_id));
      return `<div class="conversation ${state.active?.id===c.id?'active':''}" data-id="${c.id}">
        <div class="conversation-top">
          <strong><span class="presence-dot ${online?'online':''}"></span>${escapeHtml(c.name)}</strong>
          <small>${c.last_message_at?new Date(c.last_message_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''}</small>
        </div>
        <p>${escapeHtml(c.last_message||c.department||c.type)}</p>
      </div>`;
    }).join('');
  document.querySelectorAll('.conversation').forEach(el=>el.onclick=()=>openConversation(el.dataset.id));
}
$('conversationSearch').oninput=renderConversations;
async function openConversation(id){
  state.active=state.conversations.find(c=>c.id===id);
  $('conversationTitle').textContent=state.active.name;
  $('composer').classList.remove('hidden');
  $('appView').classList.add('chat-open');
  renderConversations();
  state.socket?.emit('conversation:join',{conversationId:id});
  const d=await api(`/api/conversations/${id}/messages`);
  state.messages=d.messages;
  state.unreadWhileScrolled=0;
  state.forceScrollOnNextRender=true;
  renderMessages();
  markActiveConversationRead();
}
function attachmentHtml(m){if(!m.attachment_url)return'';const url=escapeHtml(m.attachment_url);if(m.message_type==='image')return`<button class="media-open" data-type="image" data-url="${url}"><img src="${url}" alt="imagen" loading="lazy"></button>`;if(m.message_type==='video')return`<video controls preload="metadata" src="${url}"></video>`;if(m.message_type==='audio')return`<audio controls preload="metadata" src="${url}"></audio>`;return`<a class="file-card" target="_blank" rel="noopener" href="${url}"><span>📎</span><div><strong>${escapeHtml(m.attachment_name||'Archivo')}</strong><small>${formatBytes(m.attachment_size)}</small></div></a>`}
function messageStatusHtml(m){
  if(m.sender_id!==state.user.id)return'';
  if(Number(m.read_count||0)>0)return'<span class="checks read">✓✓</span>';
  if(Number(m.delivered_count||0)>0)return'<span class="checks">✓✓</span>';
  return'<span class="checks">✓</span>';
}

function replyHtml(m){
  if(!m.reply_to)return'';
  return `<button class="reply-quote" data-jump="${m.reply_to.id}">
    <strong>${escapeHtml(m.reply_to.sender_name||'Mensaje')}</strong>
    <span>${escapeHtml(m.reply_to.body||m.reply_to.attachment_name||m.reply_to.message_type||'Archivo')}</span>
  </button>`;
}

function reactionsHtml(m){
  const reactions=Array.isArray(m.reactions)?m.reactions:[];
  if(!reactions.length)return'';
  return `<div class="message-reactions">${reactions.map(r=>`<button data-message="${m.id}" data-emoji="${escapeHtml(r.emoji)}">${escapeHtml(r.emoji)} <span>${Number(r.count||0)}</span></button>`).join('')}</div>`;
}


function isNearBottom(list=$('messageList'),threshold=120){
  return list.scrollHeight-list.scrollTop-list.clientHeight<=threshold;
}

function scrollToBottom({smooth=false}={}){
  const list=$('messageList');
  requestAnimationFrame(()=>{
    list.scrollTo({
      top:list.scrollHeight,
      behavior:smooth?'smooth':'auto'
    });
    state.unreadWhileScrolled=0;
    updateScrollBottomButton();
  });
}

function updateScrollBottomButton(){
  const near=isNearBottom();
  $('scrollBottomBtn').classList.toggle('hidden',near);
  $('newMessageCount').textContent=String(state.unreadWhileScrolled||0);
  $('newMessageCount').classList.toggle('hidden',!state.unreadWhileScrolled);
}

function preserveScrollAndRender(renderFn){
  const list=$('messageList');
  const near=isNearBottom(list);
  const oldBottom=list.scrollHeight-list.scrollTop;
  renderFn();
  requestAnimationFrame(()=>{
    if(near||state.forceScrollOnNextRender){
      state.forceScrollOnNextRender=false;
      scrollToBottom();
    }else{
      list.scrollTop=Math.max(0,list.scrollHeight-oldBottom);
      updateScrollBottomButton();
    }
  });
}

function renderMessages(){
  const list=$('messageList');
  const wasNearBottom=isNearBottom(list);

  list.innerHTML=state.messages.map(m=>`<article id="message-${m.id}" class="message ${m.sender_id===state.user.id?'mine':''}" data-message-id="${m.id}">
    ${m.sender_id!==state.user.id?`<div class="message-name">${escapeHtml(m.sender_name||'Usuario')}</div>`:''}
    ${replyHtml(m)}
    ${attachmentHtml(m)}
    ${m.body?`<div class="message-body">${escapeHtml(m.body)}</div>`:''}
    <div class="message-footer">
      <button class="message-more" data-message-id="${m.id}" title="Opciones" type="button">⌄</button>
      <span class="message-time">${new Date(m.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>
      ${messageStatusHtml(m)}
    </div>
    ${reactionsHtml(m)}
  </article>`).join('');

  list.querySelectorAll('.media-open').forEach(btn=>btn.onclick=()=>openViewer(btn.dataset.type,btn.dataset.url));
  list.querySelectorAll('.reply-quote').forEach(btn=>btn.onclick=()=>jumpToMessage(btn.dataset.jump));
  list.querySelectorAll('.message-more').forEach(btn=>btn.onclick=e=>openMessageMenu(e,btn.dataset.messageId));
  list.querySelectorAll('.message-reactions button').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation();
    toggleReaction(btn.dataset.message,btn.dataset.emoji);
  });

  list.querySelectorAll('img,video,audio').forEach(media=>{
    media.addEventListener('loadedmetadata',()=>{if(wasNearBottom)scrollToBottom()},{once:true});
    media.addEventListener('load',()=>{if(wasNearBottom)scrollToBottom()},{once:true});
  });

  if(state.forceScrollOnNextRender||wasNearBottom){
    state.forceScrollOnNextRender=false;
    scrollToBottom();
  }else{
    updateScrollBottomButton();
  }
}

function jumpToMessage(id){
  const el=$(`message-${id}`);
  if(!el)return;
  el.scrollIntoView({behavior:'smooth',block:'center'});
  el.classList.add('message-highlight');
  setTimeout(()=>el.classList.remove('message-highlight'),1500);
}

function connectSocket(){
  if(state.socket)return;
  state.socket=io({auth:{token:state.token}});

  state.socket.on('message:new',m=>{
    const c=state.conversations.find(x=>x.id===m.conversation_id);
    if(c){
      c.last_message=m.body||m.attachment_name||'Archivo';
      c.last_message_at=m.created_at;
      renderConversations();
    }

    if(state.active?.id===m.conversation_id&&!state.messages.some(x=>x.id===m.id)){
      const near=isNearBottom();
      state.messages.push(m);

      if(m.sender_id===state.user.id||near){
        state.forceScrollOnNextRender=true;
      }else{
        state.unreadWhileScrolled+=1;
      }

      renderMessages();
      markActiveConversationRead();
    }
  });

  state.socket.on('message:receipt',receipt=>{
    const m=state.messages.find(x=>x.id===receipt.messageId);
    if(!m)return;
    m.read_count=Number(receipt.readCount||0);
    m.delivered_count=Number(receipt.deliveredCount||0);
    m.receipt_count=Number(receipt.receiptCount||0);
    preserveScrollAndRender(renderMessages);
  });

  state.socket.on('message:reactions',event=>{
    const m=state.messages.find(x=>x.id===event.messageId);
    if(!m)return;
    m.reactions=event.reactions||[];
    preserveScrollAndRender(renderMessages);
  });

  state.socket.on('presence:update',event=>{
    const key=String(event.userId);
    if(event.online)state.onlineUsers.add(key);
    else state.onlineUsers.delete(key);
    renderConversations();
  });

  state.socket.on('typing:update',e=>{
    if(e.conversationId!==state.active?.id||e.userId===state.user.id)return;
    $('typingLabel').textContent=e.typing?`${e.name} está escribiendo...`:'';
  });

  state.socket.on('ai-action:new',action=>{
    state.aiActions.unshift(action);
    renderAiActions();
  });

  state.socket.on('ai-action:update',action=>{
    const index=state.aiActions.findIndex(x=>x.id===action.id);
    if(index>=0)state.aiActions[index]={...state.aiActions[index],...action};
    renderAiActions();
  });

  state.socket.on('connect_error',e=>console.warn(e.message));
}

async function markActiveConversationRead(){
  if(!state.active||document.hidden)return;
  state.socket?.emit(
    'conversation:read',
    {conversationId:state.active.id},
    response=>{
      if(!response?.ok)return;
    }
  );
}

$('messageList').addEventListener('scroll',()=>{
  updateScrollBottomButton();
  if(isNearBottom()){
    state.unreadWhileScrolled=0;
    updateScrollBottomButton();
    markActiveConversationRead();
  }
},{passive:true});

$('scrollBottomBtn').onclick=()=>{
  scrollToBottom({smooth:true});
  markActiveConversationRead();
};

document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&state.active){
    scrollToBottom();
    markActiveConversationRead();
  }
});

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
      $('audioRecorderBar').classList.remove('locked','cancel-ready','lock-ready');
      $('voiceRecordBtn').classList.remove('recording');
      document.body.classList.remove('recording-audio');

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

    document.body.classList.add('recording-audio');
    $('voiceRecordBtn').classList.add('recording');
    $('audioRecorderBar').classList.remove('hidden');
    $('recordHint').textContent='Desliza para cancelar ‹';
    $('recordLockHint').textContent='⌃';
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
  $('audioRecorderBar').style.removeProperty('--record-dx');
  $('audioRecorderBar').classList.remove('cancel-ready','lock-ready');

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
  const bar=$('audioRecorderBar');

  bar.style.setProperty('--record-dx',`${Math.min(0,dx)}px`);
  bar.classList.toggle('cancel-ready',dx<-55);
  bar.classList.toggle('lock-ready',dy<-55);
  $('recordHint').textContent=dx<-55?'Suelta para cancelar':'Desliza para cancelar ‹';
  $('recordLockHint').textContent=dy<-55?'🔒':'⌃';

  if(dx<-105){
    voiceGesture.active=false;
    finishAudioRecording(true);
    $('uploadStatus').textContent='Audio cancelado';
    return;
  }

  if(dy<-105){
    voiceGesture.locked=true;
    bar.classList.add('locked');
    bar.classList.remove('lock-ready');
    bar.style.removeProperty('--record-dx');
    $('recordHint').textContent='Grabación bloqueada';
    $('recordLockHint').textContent='🔒';
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


function setReply(message){
  state.replyTo=message;
  $('replyAuthor').textContent=message.sender_name||'Mensaje';
  $('replyText').textContent=message.body||message.attachment_name||'Archivo';
  $('replyPreview').classList.remove('hidden');
  $('messageInput').focus();
}

function clearReply(){
  state.replyTo=null;
  $('replyPreview').classList.add('hidden');
  $('replyAuthor').textContent='';
  $('replyText').textContent='';
}

$('cancelReplyBtn').onclick=clearReply;

function closeReactionPicker(){
  $('reactionOverlay').classList.add('hidden');
  state.reactionTarget=null;
}

function openMessageMenu(event,messageId){
  event.preventDefault();
  event.stopPropagation();
  state.reactionTarget=messageId;
  $('reactionPicker').dataset.messageId=messageId;
  $('reactionOverlay').classList.remove('hidden');
}

async function toggleReaction(messageId,emoji){
  try{
    const d=await api(`/api/messages/${messageId}/reactions`,{
      method:'POST',
      body:JSON.stringify({emoji})
    });
    const m=state.messages.find(x=>x.id===messageId);
    if(m)m.reactions=d.reactions||[];
    preserveScrollAndRender(renderMessages);
  }catch(error){
    $('uploadStatus').textContent=error.message;
  }
}

$('replyFromPickerBtn').onclick=()=>{
  const messageId=$('reactionPicker').dataset.messageId||state.reactionTarget;
  const message=state.messages.find(x=>x.id===messageId);
  closeReactionPicker();
  if(message)setReply(message);
};

$('reactionPicker').querySelectorAll('[data-emoji]').forEach(btn=>{
  btn.onclick=()=>{
    const messageId=$('reactionPicker').dataset.messageId||state.reactionTarget;
    closeReactionPicker();
    toggleReaction(messageId,btn.dataset.emoji);
  };
});

$('reactionBackdrop').onclick=closeReactionPicker;
$('closeReactionBtn').onclick=closeReactionPicker;
$('reactionPicker').onclick=event=>event.stopPropagation();
document.addEventListener('keydown',event=>{
  if(event.key==='Escape')closeReactionPicker();
});

$('searchMessagesBtn').onclick=()=>{
  if(!state.active)return;
  $('searchModal').classList.remove('hidden');
  $('messageSearchInput').value='';
  $('messageSearchResults').innerHTML='';
  $('messageSearchInput').focus();
};

$('closeSearchBtn').onclick=()=>$('searchModal').classList.add('hidden');

let searchTimer=null;
$('messageSearchInput').oninput=()=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(searchMessages,250);
};

async function searchMessages(){
  const q=$('messageSearchInput').value.trim();
  if(!q||!state.active){
    $('messageSearchResults').innerHTML='';
    return;
  }

  try{
    const d=await api(`/api/conversations/${state.active.id}/search?q=${encodeURIComponent(q)}`);
    $('messageSearchResults').innerHTML=(d.messages||[]).map(m=>`
      <button data-id="${m.id}">
        <strong>${escapeHtml(m.sender_name||'Usuario')}</strong>
        <span>${escapeHtml(m.body||m.attachment_name||'Archivo')}</span>
        <small>${new Date(m.created_at).toLocaleString()}</small>
      </button>
    `).join('')||'<div class="empty">No se encontraron mensajes.</div>';

    $('messageSearchResults').querySelectorAll('button').forEach(btn=>{
      btn.onclick=()=>{
        $('searchModal').classList.add('hidden');
        jumpToMessage(btn.dataset.id);
      };
    });
  }catch(error){
    $('messageSearchResults').innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const rawData=atob(base64);
  return Uint8Array.from([...rawData].map(char=>char.charCodeAt(0)));
}

$('notificationsBtn').onclick=enablePushNotifications;

async function enablePushNotifications(){
  if(!('serviceWorker'in navigator)||!('PushManager'in window)){
    $('uploadStatus').textContent='Este dispositivo no permite notificaciones push.';
    return;
  }

  try{
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw new Error('Permiso de notificaciones no concedido');

    const keyData=await api('/api/push/public-key');
    if(!keyData.publicKey)throw new Error('Faltan las claves VAPID en Render');

    const registration=await navigator.serviceWorker.ready;
    let subscription=await registration.pushManager.getSubscription();

    if(!subscription){
      subscription=await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:urlBase64ToUint8Array(keyData.publicKey)
      });
    }

    await api('/api/push/subscribe',{
      method:'POST',
      body:JSON.stringify({subscription})
    });

    $('uploadStatus').textContent='Notificaciones activadas';
  }catch(error){
    $('uploadStatus').textContent=error.message;
  }
}

async function loadAiActions(){
  if(!isAdmin())return;
  try{
    const d=await api('/api/admin/ai-actions');
    state.aiActions=d.actions||[];
    renderAiActions();
  }catch(error){
    console.warn(error.message);
  }
}

function renderAiActions(){
  if(!isAdmin())return;
  const actions=state.aiActions.filter(a=>state.aiFilter==='all'||a.status===state.aiFilter);
  $('aiActionList').innerHTML=actions.map(a=>`
    <article class="ai-action ${escapeHtml(a.priority||'Normal').toLowerCase()}">
      <div class="ai-action-head">
        <strong>${escapeHtml(a.unit||'Sin unidad')}</strong>
        <span>${escapeHtml(a.priority||'Normal')}</span>
      </div>
      <small>${escapeHtml(a.requester_name||'Empleado')} · ${escapeHtml(a.department||'Operations')}</small>
      <p>${escapeHtml(a.summary||'')}</p>
      <div class="ai-action-buttons">
        <button data-status="approved" data-id="${a.id}">Aprobar</button>
        <button data-status="completed" data-id="${a.id}">Completar</button>
        <button data-status="dismissed" data-id="${a.id}">Descartar</button>
      </div>
    </article>
  `).join('')||'<div class="empty">No hay acciones en esta bandeja.</div>';

  $('aiActionList').querySelectorAll('[data-status]').forEach(btn=>{
    btn.onclick=()=>updateAiAction(btn.dataset.id,btn.dataset.status);
  });
}

async function updateAiAction(id,status){
  try{
    const d=await api(`/api/admin/ai-actions/${id}`,{
      method:'PATCH',
      body:JSON.stringify({status})
    });
    const index=state.aiActions.findIndex(x=>x.id===id);
    if(index>=0)state.aiActions[index]=d.action;
    renderAiActions();
  }catch(error){
    alert(error.message);
  }
}

document.querySelectorAll('[data-ai-filter]').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('[data-ai-filter]').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    state.aiFilter=btn.dataset.aiFilter;
    renderAiActions();
  };
});

$('closeAiPanelBtn').onclick=()=>$('aiPanel').classList.toggle('hidden');

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
}
bootstrap();
