import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ListingWorkspaceFixture } from './listing-workspace.fixture';
export class CapacityFixture extends ListingWorkspaceFixture {
  async plan(listings: number, seats = 4) {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats) VALUES($1::uuid,$1::text,1,'ORGANIZATION',$2,$3)`,
      [id, listings, seats],
    );
    return id;
  }
  async assigned(listings = 1, seats = 4) {
    const user = await this.user();
    const w = await this.workspaceFor(user);
    const plan = await this.plan(listings, seats);
    await this.change(w.id, w.owner, plan);
    return { ...w, plan };
  }
  async change(
    workspace: string,
    owner: string,
    plan: string | null,
    mode = 'VOLUNTARY',
  ) {
    return this.runtimeSql(workspace, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
        workspace,
      ]);
      await c.query(
        `UPDATE workspace_plan_assignments SET plan_version_id=$2,source='INTERNAL',change_mode=$3,command_id=$4,actor_membership_id=$5 WHERE workspace_id=$1`,
        [workspace, plan, mode, randomUUID(), owner],
      );
    });
  }
  async insert(
    c: PoolClient,
    w: { id: string; owner: string },
    id = randomUUID(),
    predecessor: string | null = null,
  ) {
    await c.query(
      `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,photos,predecessor_listing_id) VALUES($1,$2,$3,$3,(SELECT coalesce(max(display_order),0)+1 FROM listings WHERE workspace_id=$2),ARRAY[]::text[],$4)`,
      [id, w.id, w.owner, predecessor],
    );
    await c.query(
      `INSERT INTO listing_assignment_transitions(id,workspace_id,listing_id,sequence,new_membership_id,reason,initiated_by_membership_id,command_id) VALUES($1,$2,$3,1,$4,'INITIAL',$4,$5)`,
      [randomUUID(), w.id, id, w.owner, randomUUID()],
    );
    return id;
  }
  async create(
    w: { id: string; owner: string },
    predecessor: string | null = null,
  ) {
    return this.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      return this.insert(c, w, randomUUID(), predecessor);
    });
  }
}
