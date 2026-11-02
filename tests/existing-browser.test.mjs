import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ExistingBrowser,existingEndpoint} from '../dist/existing-browser.js';
class Page extends EventEmitter {
 constructor(url){super();this.address=url;this.frame={};this.closed=false;}
 url(){return this.address;} isClosed(){return this.closed;} mainFrame(){return this.frame;}
 navigate(url){this.address=url;this.emit('framenavigated',this.frame);}
}
function fixture(){const one=new Page('https://vcpc.snakes.moe/'),two=new Page('https://vcpc.snakes.moe/'),other=new Page('https://example.com/private');let disconnected=false;const browser={contexts:()=>[{pages:()=>[one,two,other]}],isConnected:()=>!disconnected,version:()=> 'test',close:async()=>{disconnected=true;}};return {one,two,other,browser,connection:new ExistingBrowser(browser)};}
test('only site candidates, explicit unique handles; page lifecycle invalidates binding',async()=>{const {one,two,connection}=fixture();const targets=connection.listTargets();assert.equal(targets.length,2);assert.notEqual(targets[0].target_id,targets[1].target_id);assert.throws(()=>connection.bind('bad'),/target_mismatch/);const bound=connection.bind(targets[1].target_id);assert.equal(bound.page,two);connection.assertBound(bound.binding_id);one.navigate('https://example.com/');connection.assertBound(bound.binding_id);two.navigate('https://vcpc.snakes.moe/');assert.throws(()=>connection.assertBound(bound.binding_id),/binding_invalid/);await connection.close();assert.equal(two.isClosed(),false);});
test('discovery IDs expire on navigation, even returning to the same URL',async()=>{const {one,connection}=fixture();const id=connection.listTargets()[0].target_id;one.navigate('https://example.com/');one.navigate('https://vcpc.snakes.moe/');assert.throws(()=>connection.bind(id),/target_mismatch/);assert.notEqual(connection.listTargets()[0].target_id,id);await connection.close();});
test('endpoints are local and configured outside tool arguments',()=>{assert.equal(existingEndpoint({}),'chrome');assert.equal(existingEndpoint({VCPC_CDP_ENDPOINT:'http://127.0.0.1:9222'}),'http://127.0.0.1:9222');for(const value of ['http://example.com:9222','http://user:pass@localhost:9222','file:///tmp/x','https://localhost:9222'])assert.throws(()=>existingEndpoint({VCPC_CDP_ENDPOINT:value}),/invalid_cdp_endpoint/);});
