export type Frequency = 'daily'|'weekly'|'monthly';
export function localDay(timestamp:number,timezone:string):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(timestamp);
 return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');
}
export function periodFor(timestamp:number,timezone:string,frequency:Frequency):string {
 const day=localDay(timestamp,timezone);if(frequency==='monthly')return day.slice(0,7);
 if(frequency==='daily')return day;
 const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);
}
export function nextPeriod(period:string,frequency:Frequency,step=1):string {
 const d=new Date(period+(frequency==='monthly'?'-01':'')+'T00:00:00Z');
 if(frequency==='monthly')d.setUTCMonth(d.getUTCMonth()+step);else d.setUTCDate(d.getUTCDate()+step*(frequency==='weekly'?7:1));
 return d.toISOString().slice(0,frequency==='monthly'?7:10);
}
export function loopStats(periods:string[],current:string,frequency:Frequency,target:number){
 const counts:Record<string,number>={};for(const p of periods)counts[p]=(counts[p]||0)+1;
 const qualified=Object.keys(counts).filter(p=>(counts[p]||0)>=target).sort();let best=0,run=0,last='';
 for(const p of qualified){run=last&&nextPeriod(last,frequency)===p?run+1:1;best=Math.max(best,run);last=p;}
 let cursor=(counts[current]||0)>=target?current:nextPeriod(current,frequency,-1),streak=0;
 while((counts[cursor]||0)>=target){streak++;cursor=nextPeriod(cursor,frequency,-1);}
 return {currentPeriod:current,progress:counts[current]||0,target,currentStreak:streak,bestStreak:best,total:periods.length};
}
