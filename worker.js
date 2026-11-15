const PLANS = {30: 50000, 90: 130000}; // paise
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':globalThis.ALLOWED_ORIGIN||'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}});
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let out=0;for(let i=0;i<a.length;i++)out|=a.charCodeAt(i)^b.charCodeAt(i);return out===0;}
async function supabase(env,path,options={}){
  const res=await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:'return=representation',...(options.headers||{})}});
  const body=await res.text();if(!res.ok)throw new Error(`Supabase error: ${body}`);return body?JSON.parse(body):null;
}
async function razorpay(env,path,options={}){
  const auth=btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res=await fetch(`https://api.razorpay.com/v1/${path}`,{...options,headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json',...(options.headers||{})}});
  const data=await res.json();if(!res.ok)throw new Error(data.error?.description||'Razorpay API error');return data;
}
export default {
 async fetch(request,env){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN||'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}});
  const url=new URL(request.url);try{
   if(env.ALLOWED_ORIGIN && request.headers.get('Origin')!==env.ALLOWED_ORIGIN)return json({error:'Origin not allowed'},403);
   if(request.method==='GET' && url.pathname==='/seat') {
    const seat=Number(url.searchParams.get('seat'));
    if(!Number.isInteger(seat)||seat<1||seat>75)return json({error:'Invalid seat number'},400);
    const rows=await supabase(env,`seats?seat_number=eq.${seat}&select=seat_number,status,student_name,phone,expiry_date`);
    return rows?.length?json({seat:rows[0]}):json({error:'Seat not found'},404);
   }
   if(request.method!=='POST')return json({error:'Method not allowed'},405);
   const body=await request.json();
   if(url.pathname==='/create-order'){
    const seat=Number(body.seat_number),days=Number(body.days),amount=PLANS[days];
    if(!Number.isInteger(seat)||seat<1||seat>75||!amount)return json({error:'Invalid seat or plan'},400);
    const rows=await supabase(env,`seats?seat_number=eq.${seat}&select=seat_number,status`);
    if(!rows?.length||rows[0].status!=='occupied')return json({error:'यह सीट रिन्यूअल के लिए उपलब्ध नहीं है।'},400);
    const order=await razorpay(env,'orders',{method:'POST',body:JSON.stringify({amount,currency:'INR',receipt:`seat${seat}-${crypto.randomUUID().slice(0,8)}`,notes:{seat_number:String(seat),days:String(days)}})});
    return json({id:order.id,amount:order.amount,currency:order.currency,key_id:env.RAZORPAY_KEY_ID});
   }
   if(url.pathname==='/verify-payment'){
    const {razorpay_order_id:orderId,razorpay_payment_id:paymentId,razorpay_signature:signature}=body;
    const seat=Number(body.seat_number),days=Number(body.days),amount=PLANS[days];
    if(!orderId||!paymentId||!signature||!Number.isInteger(seat)||seat<1||seat>75||!amount)return json({error:'Invalid payment details'},400);
    const expected=await hmacHex(env.RAZORPAY_KEY_SECRET,`${orderId}|${paymentId}`);
    if(!safeEqual(expected,signature))return json({error:'Payment signature invalid'},400);
    // Independently fetch payment and order from Razorpay; never trust browser-supplied amount/status.
    const [payment,order]=await Promise.all([razorpay(env,`payments/${encodeURIComponent(paymentId)}`),razorpay(env,`orders/${encodeURIComponent(orderId)}`)]);
    if(payment.order_id!==orderId||payment.status!=='captured'||payment.amount!==amount||payment.currency!=='INR'||order.amount!==amount||order.currency!=='INR'||String(order.notes?.seat_number)!==String(seat)||String(order.notes?.days)!==String(days))return json({error:'Payment does not match this seat and plan'},400);
    // RPC performs an atomic, idempotent renewal. Duplicate payment IDs cannot extend twice.
    const result=await supabase(env,'rpc/renew_seat_payment',{method:'POST',body:JSON.stringify({p_payment_id:paymentId,p_order_id:orderId,p_seat_number:seat,p_days:days,p_amount:amount})});
    const record=Array.isArray(result)?result[0]:result;
    return json({success:true,expiry_date:record?.expiry_date||record?.renew_seat_payment||null});
   }
   return json({error:'Not found'},404);
  }catch(err){return json({error:err.message||'Server error'},500);}
 }
};
