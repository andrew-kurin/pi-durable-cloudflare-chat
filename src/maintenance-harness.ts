import {PiHarness} from 'agents/harness/pi';
import type {Maintenance} from './maintenance';
/** The gate precedes lifecycle startup and alarm recovery, not just HTTP. */
export class MaintenanceHarness extends PiHarness {
 constructor(options:ConstructorParameters<typeof PiHarness>[0],private maintenance:Maintenance){super(options);}
 override async onStart(context:Parameters<PiHarness['onStart']>[0]){if(!await this.maintenance.paused())await super.onStart(context);}
 override async onJob(context:Parameters<PiHarness['onJob']>[0]){if(!await this.maintenance.paused())return super.onJob(context);}
}
