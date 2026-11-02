export {};
const original=globalThis.fetch;
globalThis.fetch=Object.assign(async (input:RequestInfo|URL)=>{
 if(!String(input).startsWith("https://api.atmosphere.tools/2/tiktok/status/"))throw Error("Unexpected source request");
 return Response.json({status:{id:"7703354368283708703",url:"https://www.tiktok.com/@author/video/7703354368283708703",text:"Video",created_at:"2026-11-02T12:00:00Z",author:{screen_name:"author"},media:{all:[{type:"video",url:"https://media.example/video.mp4",thumbnail_url:"https://media.example/frame.jpg",duration:Number(process.env.ARENA_TEST_DURATION),width:720,height:1280}]}}});
},{preconnect:original.preconnect});
