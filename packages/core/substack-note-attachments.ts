import { z } from "zod";
import { substackArticleRecordSchema } from "./substack-article-record.ts";
import { substackNativeMediaSchema } from "./substack-native-media.ts";
const id = z.number().int().positive();
const url = z.url().refine(value => {const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!u.port;});
const upload = z.object({ id:z.uuid(),userId:id,state:z.literal("transcoded"),postId:z.null(),publicationId:z.null(),
  durationSeconds:z.number().positive(),width:id,height:id,thumbnailId:z.number().int().nonnegative() }).strict();
const video = z.object({kind:z.literal("video"),id:z.uuid(),userId:id,commentId:id,upload}).strict();
const author = z.object({id,name:z.string().min(1).max(512),handle:z.string().regex(/^[a-zA-Z0-9_]+$/).nullable()}).strict();
const selection = z.object({id:z.uuid(),postId:id,startParagraph:z.number().int().nonnegative(),endParagraph:z.number().int().nonnegative(),
  startOffset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative(),text:z.string().min(1).max(50_000),isAutoSelection:z.boolean()}).strict();
// This belongs to an article card. It is not a native audio upload to the Note.
export const substackPodcastArticleSchema=substackArticleRecordSchema.pick({version:true,id:true,publicationId:true,url:true,title:true,authors:true,observedAt:true,method:true,audience:true}).extend({
  bodyEvidence:z.object({status:z.literal("complete"),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive().max(2_000_000)}).strict(),
  audio:substackNativeMediaSchema.refine(asset=>asset.kind==="audio","Expected the article's original audio"),
}).strict();
const podcast = z.object({ uploadId:z.uuid(),userId:id,postId:id,publicationId:id,durationSeconds:z.number().positive(),
  article:substackPodcastArticleSchema.optional() }).strict();
const article = z.object({kind:z.literal("article"),id:z.uuid(),postId:id,publicationId:id,url,title:z.string().min(1).max(1000),
  previewText:z.string().max(20_000),authors:author.array().min(1).max(50),selection:selection.optional(),podcast:podcast.optional()}).strict();
export const substackPodcastAttributionSchema = z.object({kind:z.literal("substack-podcast"),attachmentId:z.uuid(),url,
  title:z.string().min(1).max(1000),authors:z.array(z.string().min(1).max(512)).min(1).max(50)}).strict();
export const substackNoteAttachmentsSchema=z.object({method:z.literal("public-api"),observedAt:z.iso.datetime(),commentId:id,userId:id,
  handle:z.string().regex(/^[a-zA-Z0-9_]+$/),bodyText:z.string().max(500_000),attachments:z.discriminatedUnion("kind",[video,article]).array().max(100)
}).strict().superRefine((e,c)=>{
  const ids=new Set<string>();
  for(const a of e.attachments){
    if(ids.has(a.id))c.addIssue({code:"custom",message:"Duplicate Substack attachment identity"});ids.add(a.id);
    if(a.kind==="video"&&(a.commentId!==e.commentId||a.userId!==e.userId||a.upload.userId!==e.userId))c.addIssue({code:"custom",message:"Substack video attachment belongs to a different Note or author"});
    if(a.kind==="article"){
      if(!/^\/p\/[^/]+$/.test(new URL(a.url).pathname)||new URL(a.url).search||new URL(a.url).hash)c.addIssue({code:"custom",message:"Substack article card needs a canonical article URL"});
      if(a.selection&&(a.selection.postId!==a.postId||a.selection.endParagraph<a.selection.startParagraph||(a.selection.endParagraph===a.selection.startParagraph&&a.selection.endOffset<a.selection.startOffset)))c.addIssue({code:"custom",message:"Substack selected excerpt belongs to a different article or invalid range"});
      if(a.podcast){
        const p=a.podcast,r=p.article;
        if(a.selection)c.addIssue({code:"custom",message:"A selected article excerpt cannot become a full podcast attachment"});
        if(p.postId!==a.postId||p.publicationId!==a.publicationId)c.addIssue({code:"custom",message:"Substack podcast belongs to a different article"});
        if(r&&(r.id!==a.postId||r.publicationId!==a.publicationId||r.url!==a.url||r.title!==a.title
          ||r.authors.length!==a.authors.length||r.authors.some((b,i)=>b.id!==a.authors[i]?.id||b.name!==a.authors[i]?.name||(a.authors[i]?.handle&&b.handle!==a.authors[i]?.handle))
          ||Date.parse(r.observedAt)>Date.now()+300_000
          ||r.audio.uploadId!==p.uploadId||r.audio.durationSeconds!==p.durationSeconds
          ||r.audio.url!==`https://api.substack.com/api/v1/audio/upload/${p.uploadId}/src`))c.addIssue({code:"custom",message:"Substack podcast lacks consistent complete public article evidence"});
      }
    }
  }
});
export type SubstackNoteAttachments=z.infer<typeof substackNoteAttachmentsSchema>;
export function substackNoteVideo(a:Extract<SubstackNoteAttachments["attachments"][number],{kind:"video"}>){
  return {kind:"video" as const,url:`https://substack.com/api/v1/video/upload/${a.upload.id}/src?type=mp4`,durationSeconds:a.upload.durationSeconds,
    width:a.upload.width,height:a.upload.height,posterUrl:`https://substack-video.s3.amazonaws.com/video_upload/user/${a.userId}/${a.upload.id}/transcoded-${String(a.upload.thumbnailId).padStart(5,"0")}.png`,
    acquisition:"substack-public-original" as const};
}
export function substackNotePodcastAudio(a:Extract<SubstackNoteAttachments["attachments"][number],{kind:"article"}>){
  const p=a.podcast;
  if(!p?.article)return undefined;
  return {kind:"audio" as const,url:`https://api.substack.com/api/v1/audio/upload/${p.uploadId}/src`,durationSeconds:p.durationSeconds,
    acquisition:"substack-public-original" as const,sourceAttribution:{kind:"substack-podcast" as const,attachmentId:a.id,url:a.url,title:a.title,authors:a.authors.map(author=>author.name)}};
}
