// Support the delivery list's status filters and updated_at ordering for global,
// branch-scoped, and assigned-to views. Replace the shorter indexes with composites.
export async function up(knex) {
  await knex.schema.alterTable('deliveries', (t) => {
    t.dropIndex(['branch_id', 'status'], 'deliveries_branch_id_status_index');
    t.dropIndex(['assigned_to', 'status'], 'deliveries_assigned_to_status_index');
    t.index(['status', 'updated_at'], 'deliveries_status_updated_at_index');
    t.index(['branch_id', 'status', 'updated_at'], 'deliveries_branch_status_updated_at_index');
    t.index(['assigned_to', 'status', 'updated_at'], 'deliveries_assignee_status_updated_at_index');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('deliveries', (t) => {
    t.dropIndex(['status', 'updated_at'], 'deliveries_status_updated_at_index');
    t.dropIndex(['branch_id', 'status', 'updated_at'], 'deliveries_branch_status_updated_at_index');
    t.dropIndex(['assigned_to', 'status', 'updated_at'], 'deliveries_assignee_status_updated_at_index');
    t.index(['branch_id', 'status'], 'deliveries_branch_id_status_index');
    t.index(['assigned_to', 'status'], 'deliveries_assigned_to_status_index');
  });
}
