  if(messageId){
    try{
      const edited=await tg("editMessageText",{
        chat_id:chat,
        message_id:messageId,
        text:text,
        reply_markup:markup,
        disable_web_page_preview:true
      });
      activeGameChats.set(String(chat)+"_message_id",messageId);
      lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
      return edited;
    }catch(e){
      const msg=String(e.message||"");
      // Если текущее сообщение содержит фотографию, Telegram не позволяет
      // заменить caption на text. Редактируем caption того же сообщения.
      if(/there is no text in the message|message can't be edited|text.*message/i.test(msg)){
        try{
          const edited=await tg("editMessageCaption",{
            chat_id:chat,
            message_id:messageId,
            caption:text.slice(0,1024),
            reply_markup:markup
          });
          activeGameChats.set(String(chat)+"_message_id",messageId);
          lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
          return edited;
        }catch(captionError){
          const captionMsg=String(captionError.message||"");
          if(!/message is not modified/i.test(captionMsg)) console.log("GAME SCREEN EDIT ERROR:",captionMsg);
        }
      }else if(!/message is not modified/i.test(msg)){
        console.log("GAME SCREEN EDIT ERROR:",msg);
      }
      if(/message is not modified/i.test(msg)){
        lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
        return {message_id:messageId,deduplicated:true};
      }
      // Keep exactly one visible analysis message. If Telegram refuses to edit
      // the previous message, remove it before creating the replacement.
      try{await tg("deleteMessage",{chat_id:chat,message_id:messageId});}
      catch(deleteError){console.log("GAME SCREEN OLD MESSAGE DELETE ERROR:",deleteError.message);}
      activeGameChats.delete(String(chat)+"_message_id");
    }
  }

  let sent=null;
  try {
    const image=await Promise.race([userBridge.getGameMedia(latest.message_id),new Promise(resolve=>setTimeout(()=>resolve(null),700))]);
    if(image) sent=await tgPhoto(chat,image,text.slice(0,1000),markup);
  } catch(e) { console.log("GAME PHOTO SEND ERROR:",e.message); }
  if(!sent) sent=await send(chat,text,{reply_markup:markup});
  if(sent?.message_id){
    activeGameChats.set(String(chat)+"_message_id",sent.message_id);
    lastRenderedGameFingerprints.set(String(chat),gameFingerprint);
  }
  return sent;
}
async function renderGame(chat,options={}){
  return withTimeout(renderGameNow(chat,options),18000,"GAME RENDER");
}