import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:1600,height:950}, deviceScaleFactor:2 });
const errs=[]; p.on('pageerror',e=>errs.push(String(e).slice(0,300)));
p.on('console',m=>{if(m.type()==='error')errs.push('c: '+m.text().slice(0,300));});
await p.goto('http://localhost:3201/',{waitUntil:'networkidle'});
await p.waitForTimeout(7000);
await p.screenshot({path:'t_idle.png'});
await p.getByText('Draft a post about the voice rebuild').click();
await p.waitForTimeout(6000);
await p.screenshot({path:'t_attend.png'});
console.log('errors:', errs.length?errs.slice(0,5):'none');
await b.close();
