import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Journal,Record} from './core';
export class PublicationJournal implements Journal {
 private db:DatabaseSync;
 constructor(path:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY, record TEXT NOT NULL)');}
 get(id:string){const row=this.db.prepare('SELECT record FROM publications WHERE id=?').get(id) as {record:string}|undefined;return row?JSON.parse(row.record) as Record:undefined;}
 reserve(r:Record){this.db.prepare('INSERT OR IGNORE INTO publications(id,record) VALUES (?,?)').run(r.input.id,JSON.stringify(r));return this.get(r.input.id)!;}
 put(r:Record){const next={...r,version:r.version+1};const result=this.db.prepare("UPDATE publications SET record=? WHERE id=? AND json_extract(record,'$.version')=? AND json_extract(record,'$.fingerprint')=?").run(JSON.stringify(next),r.input.id,r.version,r.fingerprint);if(result.changes!==1)return false;r.version=next.version;return true;}
 close(){this.db.close();}
}
