import {fail,jsonRequest,record,text,type FetchPort} from './protocol.js';
import type {AppId} from '../../shared/app-connectors.js';
export const GOOGLE_OPERATIONS:Partial<Record<AppId,readonly string[]>>={gmail:['list_messages','read_message'],google_calendar:['list_calendars','list_events'],google_drive:['list_files','read_file_metadata'],google_docs:['read_document'],google_sheets:['read_spreadsheet','read_values']};
const resource=(value:unknown)=>{const result=text(value,200);if(!/^[A-Za-z0-9_@.\-]+$/.test(result))fail('조회할 리소스 ID를 확인하세요.');return result;};
export function googleRequest(id:AppId,operation:string,args:Record<string,unknown>):string{
  if(!GOOGLE_OPERATIONS[id]?.includes(operation))fail('지원하지 않는 Google 읽기 작업입니다.');
  const allowed:Record<string,string[]>={list_messages:['query'],read_message:['resourceId'],list_calendars:[],list_events:['resourceId','timeMin','timeMax'],list_files:['query'],read_file_metadata:['resourceId'],read_document:['resourceId'],read_spreadsheet:['resourceId'],read_values:['resourceId','range']};
  if(Object.keys(args).some(key=>!allowed[operation]!.includes(key)))fail('이 읽기 작업에 허용되지 않은 입력입니다.');
  let path:string,params:Record<string,string>={};
  if(operation==='list_messages'){path='https://gmail.googleapis.com/gmail/v1/users/me/messages';params={maxResults:'20',...(args.query===undefined?{}:{q:text(args.query,500)})};}
  else if(operation==='read_message'){path=`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(resource(args.resourceId))}`;params={format:'full'};}
  else if(operation==='list_calendars'){path='https://www.googleapis.com/calendar/v3/users/me/calendarList';params={maxResults:'20'};}
  else if(operation==='list_events'){path=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(resource(args.resourceId??'primary'))}/events`;params={maxResults:'20',singleEvents:'true',orderBy:'startTime'};for(const field of ['timeMin','timeMax'])if(args[field]!==undefined){const value=text(args[field],40);if(!Number.isFinite(Date.parse(value)))fail('조회 기간을 확인하세요.');params[field]=value;}}
  else if(operation==='list_files'){path='https://www.googleapis.com/drive/v3/files';params={pageSize:'20',fields:'files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken',q:'trashed = false'};if(args.query!==undefined){const query=text(args.query,200).replaceAll('\\','\\\\').replaceAll("'","\\'");params.q+=` and name contains '${query}'`;}}
  else if(operation==='read_file_metadata'){path=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(resource(args.resourceId))}`;params={fields:'id,name,mimeType,size,modifiedTime,webViewLink,description'};}
  else if(operation==='read_document'){path=`https://docs.googleapis.com/v1/documents/${encodeURIComponent(resource(args.resourceId))}`;}
  else if(operation==='read_spreadsheet'){path=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(resource(args.resourceId))}`;params={fields:'spreadsheetId,spreadsheetUrl,properties(title,locale),sheets(properties)'};}
  else{const range=text(args.range,200),cells=/^(?:'?[^'!]{1,100}'?!)?([A-Z]{1,3})([1-9]\d{0,5})(?::([A-Z]{1,3})([1-9]\d{0,5}))?$/.exec(range);if(!cells)fail('명시적인 A1 셀 범위를 사용하세요.');const column=(name:string)=>[...name].reduce((value,char)=>value*26+char.charCodeAt(0)-64,0);const width=column(cells[3]??cells[1]!)-column(cells[1]!)+1,height=Number(cells[4]??cells[2])-Number(cells[2])+1;if(width<1||height<1||width*height>1000)fail('한 번에 최대 1,000개 셀만 조회할 수 있습니다.');path=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(resource(args.resourceId))}/values/${encodeURIComponent(range)}`;}
  const url=new URL(path);for(const [key,value]of Object.entries(params))url.searchParams.set(key,value);return url.href;
}
export async function googleRead(fetcher:FetchPort,id:AppId,operation:string,args:Record<string,unknown>,token:string,signal:AbortSignal):Promise<Record<string,unknown>>{
  const result=await jsonRequest(fetcher,'google',googleRequest(id,operation,args),{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}},signal);
  if(operation!=='read_message')return result;
  const payload=record(result.payload),headers=Array.isArray(payload.headers)?payload.headers.map(record).filter(header=>typeof header.name==='string'&&['from','to','subject','date'].includes(header.name.toLowerCase())):[];
  const parts:string[]=[];let visited=0;const collect=(part:Record<string,unknown>,depth=0)=>{if(++visited>100||depth>15)return;if(part.mimeType==='text/plain'&&part.body){const body=record(part.body);if(typeof body.data==='string')parts.push(Buffer.from(body.data,'base64url').toString('utf8'));}if(Array.isArray(part.parts))for(const child of part.parts)collect(record(child),depth+1);};collect(payload);
  const content=parts.join('\n');return {id:result.id,threadId:result.threadId,snippet:result.snippet,headers,text:content.slice(0,30_000),truncated:content.length>30_000,notice:'첨부파일과 HTML 본문은 자동으로 열지 않습니다.'};
}
export async function googleTest(fetcher:FetchPort,id:AppId,token:string,signal:AbortSignal,resourceId?:string):Promise<void>{
  if(id==='gmail'){await jsonRequest(fetcher,'google','https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}},signal);return;}
  if(id==='google_calendar'){await googleRead(fetcher,id,'list_calendars',{},token,signal);return;}
  if(id==='google_drive'){await googleRead(fetcher,id,'list_files',{},token,signal);return;}
  if(!resourceId)fail('실제 API 검사를 위해 조회 권한이 있는 문서 또는 스프레드시트 ID를 입력하세요.');
  await googleRead(fetcher,id,id==='google_docs'?'read_document':'read_spreadsheet',{resourceId},token,signal);
}
