import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import axios from "axios";
import { premiumImageBenefits, premiumImageConfig } from "./fixtures/premium-images.ts";

const cutoff=Date.parse("2026-11-28T16:00:00.000Z");
mock.timers.enable({apis:["Date"],now:cutoff-1000});
process.env.JIMENG_ACCOUNT_PRIORITY=JSON.stringify({schema:"jimeng-account-priority-v1",revision:1,primaryAccountId:"temporary",fallbackAccountId:"owned",primaryUntil:new Date(cutoff).toISOString()});
process.env.JIMENG_ACCOUNT_CREDIT_FLOORS='{"temporary":56540}';
const {database:db,createApiKey,validateApiKey}=await import("../src/lib/database.ts");
const pool=await import("../src/lib/account-pool.ts");
pool.setMembershipStatusProvider(undefined);
for(const id of ["temporary","owned"]){const a=pool.createAccount({name:id+"_超级",sessionId:"fixture-priority-"+id});db.prepare("UPDATE jimeng_accounts SET id=?,total_credit=?,status_checked_at=? WHERE id=?").run(id,id==="temporary"?56640:90000,new Date().toISOString(),a.id);}
const {key}=createApiKey("legacy-priority-fixture"),authorization=`Bearer ${key}`,owner=validateApiKey(key).apiKeyId!;
pool.grantAccountLease(owner,"owned");
let crossDeadline=true,posts=0,requests:string[]=[];
axios.defaults.adapter=async config=>{
    const path=new URL(String(config.url)).pathname;requests.push(path);
    let data:unknown;
    if(path.endsWith("/get_common_config"))data=premiumImageConfig;
    else if(path.endsWith("/batch_get_user_benefit")){
        if(crossDeadline&&(db.prepare("SELECT last_used_at FROM jimeng_accounts WHERE id='temporary'").get() as any).last_used_at)mock.timers.setTime(cutoff);
        data=premiumImageBenefits();
    }else if(path.endsWith("/user_credit"))data={credit:{gift_credit:56640,purchase_credit:0,vip_credit:0}};
    else if(path.endsWith("/aigc_draft/generate")){posts++;return {data:{ret:2039,errmsg:"fixture rejected generation"},status:200,statusText:"OK",headers:{},config};}
    else throw Error("Unmocked request: "+path);
    return {data:{ret:"0",data},status:200,statusText:"OK",headers:{},config};
};
const imageRoute=(await import("../src/api/routes/images.ts")).default;
const chatRoute=(await import("../src/api/routes/chat.ts")).default;
const {createTask}=await import("../src/api/controllers/tasks.ts");
const request=(stream=false)=>({headers:{authorization},body:{model:"jimeng-image-5.0-lite",prompt:"fixture",resolution:"2k",messages:[{role:"user",content:"fixture"}],stream},validate(){return this}}) as any;
function reset(){mock.timers.setTime(cutoff-1000);posts=0;requests=[];db.prepare("UPDATE jimeng_accounts SET enabled=CASE WHEN id='temporary' THEN 1 ELSE 0 END,last_used_at=NULL,cooldown_until=NULL,status_error=NULL,status_checked_at=?").run(new Date().toISOString());crossDeadline=true;}
after(()=>{mock.timers.reset();db.close()});

test("legacy image route rechecks cutoff after free entitlement preparation without penalizing account",async()=>{
    reset();await assert.rejects(imageRoute.post["/generations"](request()),/停止接收新任务/);
    assert.equal(posts,0);assert.equal(pool.getAccount("temporary").failureCount,0);assert.equal(pool.getAccount("temporary").cooldownUntil,null);
});
test("chat synchronous and streamed images use the same final cutoff and do not retry policy rejection",async()=>{
    for(const stream of [false,true]){
        reset();
        if(!stream)await assert.rejects(chatRoute.post["/completions"](request()),/停止接收新任务/);
        else{const reply=await chatRoute.post["/completions"](request(true));let output="";for await(const chunk of reply.body)output+=chunk.toString();assert.match(output,/停止接收新任务/);assert.match(output,/\[DONE\]/);}
        assert.equal(posts,0);assert.equal(pool.getAccount("temporary").failureCount,0);
        const queries=requests.length;await new Promise(done=>setTimeout(done,25));assert.equal(requests.length,queries);
    }
});
test("free image remains available before deadline through the original entitlement checks",async()=>{
    reset();crossDeadline=false;await assert.rejects(imageRoute.post["/generations"](request()));assert.equal(posts,1);assert.ok(requests.some(path=>path.endsWith("/batch_get_user_benefit")));
});
test("ordinary explicit account cannot override priority, but an existing id is read idempotently",async()=>{
    reset();db.prepare("UPDATE jimeng_accounts SET enabled=1,cooldown_until=NULL,status_checked_at=?").run(new Date().toISOString());
    const id="priority_explicit_owned_fixture",input={id,model:"jimeng-video-seedance-2.5",prompt:"fixture",ratio:"16:9",resolution:"720p",duration:4,references:[]};
    const before=db.prepare("SELECT COUNT(*) n FROM canvas_tasks").get();
    await assert.rejects(createTask(owner,authorization,input,"owned"),/按账号优先级自动分配/);assert.deepEqual(db.prepare("SELECT COUNT(*) n FROM canvas_tasks").get(),before);assert.equal(posts,0);
    const {taskInput}=await import("../src/api/controllers/task-contract.ts"),{createHash}=await import("node:crypto");
    const fingerprint=createHash("sha256").update(JSON.stringify(taskInput(input))).digest("hex");
    db.prepare("INSERT INTO canvas_tasks(id,owner,kind,model,fingerprint,status,account_id,deadline) VALUES(?,?,'video',?,?,'succeeded','owned',?)").run(id,owner,input.model,fingerprint,Date.now());
    const previous=db.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id);assert.equal((await createTask(owner,authorization,input,"owned")).status,200);assert.deepEqual(db.prepare("SELECT * FROM canvas_tasks WHERE id=?").get(id),previous);
});
