-- Storage policies for email-attachments and media-delivery buckets

-- ============================================================
-- email-attachments bucket policies
-- ============================================================

-- Authenticated users can upload files to email-attachments
CREATE POLICY "Authenticated users can upload email attachments"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'email-attachments');

-- Authenticated users can read their own uploads in email-attachments
CREATE POLICY "Users can read own email attachments"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'email-attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Authenticated users can delete their own uploads in email-attachments
CREATE POLICY "Users can delete own email attachments"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'email-attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- media-delivery bucket policies
-- ============================================================

-- Authenticated users can upload files to media-delivery
CREATE POLICY "Authenticated users can upload media deliveries"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'media-delivery');

-- Authenticated users can read their own uploads in media-delivery
CREATE POLICY "Users can read own media deliveries"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'media-delivery'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Authenticated users can delete their own uploads in media-delivery
CREATE POLICY "Users can delete own media deliveries"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'media-delivery'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- service_role has full access by default (bypasses RLS),
-- so no explicit policies are needed for service_role.
-- ============================================================
