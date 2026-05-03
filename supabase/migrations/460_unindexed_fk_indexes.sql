-- 460_unindexed_fk_indexes.sql
--
-- Adds 86 missing indexes on foreign-key columns flagged by the Supabase
-- performance advisor (`unindexed_foreign_keys`). Without these, every
-- DELETE or UPDATE on the referenced table forces a sequential scan of
-- the referencing table to enforce the FK; with them, the lookup is an
-- index scan. On a Postgres instance under RLS pressure (see mig 461
-- for the related auth_rls_initplan fix), this is one of the bigger
-- wins available without rewriting application code.
--
-- Pure additive — no row data is touched, no policies modified.
-- IF NOT EXISTS guards make the migration idempotent.

-- 86 unindexed FK indexes
CREATE INDEX IF NOT EXISTS idx_attribute_values_merged_into_id ON public.attribute_values(merged_into_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_user_id ON public.auth_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar_connection_id ON public.calendar_events(calendar_connection_id);
CREATE INDEX IF NOT EXISTS idx_drone_custom_pins_created_by ON public.drone_custom_pins(created_by);
CREATE INDEX IF NOT EXISTS idx_drone_custom_pins_pixel_anchored_shot_id ON public.drone_custom_pins(pixel_anchored_shot_id);
CREATE INDEX IF NOT EXISTS idx_drone_custom_pins_updated_by ON public.drone_custom_pins(updated_by);
CREATE INDEX IF NOT EXISTS idx_drone_events_shoot_id ON public.drone_events(shoot_id);
CREATE INDEX IF NOT EXISTS idx_drone_events_shot_id ON public.drone_events(shot_id);
CREATE INDEX IF NOT EXISTS idx_drone_property_boundary_updated_by ON public.drone_property_boundary(updated_by);
CREATE INDEX IF NOT EXISTS idx_drone_renders_theme_id ON public.drone_renders(theme_id);
CREATE INDEX IF NOT EXISTS idx_drone_shoots_pilot_user_id ON public.drone_shoots(pilot_user_id);
CREATE INDEX IF NOT EXISTS idx_drone_shoots_theme_id ON public.drone_shoots(theme_id);
CREATE INDEX IF NOT EXISTS idx_drone_themes_inherits_from ON public.drone_themes(inherits_from);
CREATE INDEX IF NOT EXISTS idx_email_activities_performed_by ON public.email_activities(performed_by);
CREATE INDEX IF NOT EXISTS idx_email_blocked_addresses_blocked_by ON public.email_blocked_addresses(blocked_by);
CREATE INDEX IF NOT EXISTS idx_email_link_clicks_email_message_id ON public.email_link_clicks(email_message_id);
CREATE INDEX IF NOT EXISTS idx_employee_roles_team_id ON public.employee_roles(team_id);
CREATE INDEX IF NOT EXISTS idx_employee_utilizations_team_id ON public.employee_utilizations(team_id);
CREATE INDEX IF NOT EXISTS idx_engine_calibration_run_summaries_triggered_by ON public.engine_calibration_run_summaries(triggered_by);
CREATE INDEX IF NOT EXISTS idx_engine_calibration_runs_round_id ON public.engine_calibration_runs(round_id);
CREATE INDEX IF NOT EXISTS idx_engine_fewshot_examples_curated_by ON public.engine_fewshot_examples(curated_by);
CREATE INDEX IF NOT EXISTS idx_engine_settings_updated_by ON public.engine_settings(updated_by);
CREATE INDEX IF NOT EXISTS idx_feedback_comments_user_id ON public.feedback_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_items_duplicate_of ON public.feedback_items(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_finals_qa_runs_triggered_by ON public.finals_qa_runs(triggered_by);
CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON public.invite_codes(created_by);
CREATE INDEX IF NOT EXISTS idx_legacy_package_aliases_canonical_package_id ON public.legacy_package_aliases(canonical_package_id);
CREATE INDEX IF NOT EXISTS idx_media_tags_created_by_id ON public.media_tags(created_by_id);
CREATE INDEX IF NOT EXISTS idx_notification_routing_rules_created_by ON public.notification_routing_rules(created_by);
CREATE INDEX IF NOT EXISTS idx_object_registry_created_by ON public.object_registry(created_by);
CREATE INDEX IF NOT EXISTS idx_object_registry_curated_by ON public.object_registry(curated_by);
CREATE INDEX IF NOT EXISTS idx_object_registry_merged_into_id ON public.object_registry(merged_into_id);
CREATE INDEX IF NOT EXISTS idx_object_registry_candidates_approved_attribute_value_id ON public.object_registry_candidates(approved_attribute_value_id);
CREATE INDEX IF NOT EXISTS idx_object_registry_candidates_approved_object_id ON public.object_registry_candidates(approved_object_id);
CREATE INDEX IF NOT EXISTS idx_object_registry_candidates_merged_into_attribute_value_id ON public.object_registry_candidates(merged_into_attribute_value_id);
CREATE INDEX IF NOT EXISTS idx_object_registry_candidates_merged_into_object_id ON public.object_registry_candidates(merged_into_object_id);
CREATE INDEX IF NOT EXISTS idx_object_registry_candidates_reviewed_by ON public.object_registry_candidates(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_org_notes_parent_note_id ON public.org_notes(parent_note_id);
CREATE INDEX IF NOT EXISTS idx_org_notes_team_id ON public.org_notes(team_id);
CREATE INDEX IF NOT EXISTS idx_package_engine_tier_mapping_engine_grade_id ON public.package_engine_tier_mapping(engine_grade_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_logs_performed_by ON public.permission_audit_logs(performed_by);
CREATE INDEX IF NOT EXISTS idx_permission_audit_logs_permission_id ON public.permission_audit_logs(permission_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_logs_user_id ON public.permission_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_price_matrix_audit_logs_project_type_id ON public.price_matrix_audit_logs(project_type_id);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_log_old_version_id ON public.pricing_audit_log(old_version_id);
CREATE INDEX IF NOT EXISTS idx_project_activities_user_id ON public.project_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_project_notes_parent_note_id ON public.project_notes(parent_note_id);
CREATE INDEX IF NOT EXISTS idx_project_revisions_requested_by_id ON public.project_revisions(requested_by_id);
CREATE INDEX IF NOT EXISTS idx_project_revisions_template_id ON public.project_revisions(template_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_completed_by_id ON public.project_tasks(completed_by_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_package_id ON public.project_tasks(package_id);
CREATE INDEX IF NOT EXISTS idx_projects_confirmed_by ON public.projects(confirmed_by);
CREATE INDEX IF NOT EXISTS idx_projects_shortlist_editor_id ON public.projects(shortlist_editor_id);
CREATE INDEX IF NOT EXISTS idx_pulse_agent_stats_history_pulse_agent_id ON public.pulse_agent_stats_history(pulse_agent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_agency_id ON public.referrals(referred_agency_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_agent_id ON public.referrals(referred_agent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_agent_id ON public.referrals(referrer_agent_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_email_account_id ON public.scheduled_emails(email_account_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_user_id ON public.scheduled_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_backfill_log_requested_by ON public.shortlisting_backfill_log(requested_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_benchmark_results_ran_by ON public.shortlisting_benchmark_results(ran_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_events_group_id ON public.shortlisting_events(group_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_grade_configs_created_by ON public.shortlisting_grade_configs(created_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_jobs_group_id ON public.shortlisting_jobs(group_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_master_listings_regenerated_by ON public.shortlisting_master_listings(regenerated_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_master_listings_history_archived_by ON public.shortlisting_master_listings_history(archived_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_position_decisions_winner_group_id ON public.shortlisting_position_decisions(winner_group_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_prompt_versions_created_by ON public.shortlisting_prompt_versions(created_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_quarantine_group_id ON public.shortlisting_quarantine(group_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_quarantine_resolved_by ON public.shortlisting_quarantine(resolved_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_retouch_flags_group_id ON public.shortlisting_retouch_flags(group_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_retouch_flags_resolved_by ON public.shortlisting_retouch_flags(resolved_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_room_type_suggestions_approved_room_type_id ON public.shortlisting_room_type_suggestions(approved_room_type_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_room_type_suggestions_merged_into_room_type_id ON public.shortlisting_room_type_suggestions(merged_into_room_type_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_locked_by ON public.shortlisting_rounds(locked_by);
CREATE INDEX IF NOT EXISTS idx_shortlisting_space_instances_operator_merged_into ON public.shortlisting_space_instances(operator_merged_into);
CREATE INDEX IF NOT EXISTS idx_shortlisting_space_instances_operator_split_from ON public.shortlisting_space_instances(operator_split_from);
CREATE INDEX IF NOT EXISTS idx_shortlisting_space_instances_representative_group_id ON public.shortlisting_space_instances(representative_group_id);
CREATE INDEX IF NOT EXISTS idx_team_activity_feeds_actor_id ON public.team_activity_feeds(actor_id);
CREATE INDEX IF NOT EXISTS idx_tonomo_role_defaults_editing_fallback_team_id ON public.tonomo_role_defaults(editing_fallback_team_id);
CREATE INDEX IF NOT EXISTS idx_tonomo_role_defaults_onsite_fallback_team_id ON public.tonomo_role_defaults(onsite_fallback_team_id);
CREATE INDEX IF NOT EXISTS idx_tonomo_role_defaults_owner_fallback_team_id ON public.tonomo_role_defaults(owner_fallback_team_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_agency_id ON public.touchpoints(agency_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_linked_pulse_signal_id ON public.touchpoints(linked_pulse_signal_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_touchpoint_type_id ON public.touchpoints(touchpoint_type_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_granted_by ON public.user_permissions(granted_by);
