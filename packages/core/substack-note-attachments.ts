import { z } from "zod";
const id = z.number().int().positive();
const url = z.url().refine(value => {const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!u.port;});
const upload = z.object({ id:z.uuid(),userId:id,state:z.literal("transcoded"),postId:z.null(),publicationId:z.null(),
  durationSeconds:z.number().positive(),width:id,height:id,thumbnailId:z.number().int().nonnegative() }).strict();
const video = z.object({kind:z.literal("video"),id:z.uuid(),userId:id,commentId:id,upload}).strict();
const author = z.object({id,name:z.string().min(1).max(512),handle:z.string().regex(/^[a-zA-Z0-9_]+$/).nullable()}).strict();
const selection = z.object({id:z.uuid(),postId:id,startParagraph:z.number().int().nonnegative(),endParagraph:z.number().int().nonnegative(),
  startOffset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative(),text:z.string().min(1).max(50_000),isAutoSelection:z.boolean()}).strict();
const article = z.object({kind:z.literal("article"),id:z.uuid(),postId:id,publicationId:id,url,title:z.string().min(1).max(1000),
  previewText:z.string().max(20_000),authors:author.array().min(1).max(50),selection:selection.optional()}).strict();
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
    }
  }
});
export type SubstackNoteAttachments=z.infer<typeof substackNoteAttachmentsSchema>;
export function substackNoteVideo(a:Extract<SubstackNoteAttachments["attachments"][number],{kind:"video"}>){
  return {kind:"video" as const,url:`https://substack.com/api/v1/video/upload/${a.upload.id}/src?type=mp4`,durationSeconds:a.upload.durationSeconds,
    width:a.upload.width,height:a.upload.height,posterUrl:`https://substack-video.s3.amazonaws.com/video_upload/user/${a.userId}/${a.upload.id}/transcoded-${String(a.upload.thumbnailId).padStart(5,"0")}.png`,
    acquisition:"substack-public-original" as const};
}
