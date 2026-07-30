import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { api } from '../lib/api';
import { UploadInitResponse } from '@filestation/shared';

interface FileUploadProps {
  onUploadComplete: () => void;
  folderId: string | null; // null = 根目录
}

export default function FileUpload({ onUploadComplete, folderId }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    setUploading(true);
    setProgress(0);

    try {
      // v1.7：上传到当前文件夹（后端 target_folder_id 持久化，complete 直写，无需二次 PATCH）
      const initResponse = await api.post<UploadInitResponse>('/uploads', {
        filename: file.name,
        size: file.size,
        folder_id: folderId ?? undefined,
      });

      const { upload_id, upload_token, chunk_size } = initResponse.data!;

      const totalChunks = Math.ceil(file.size / chunk_size);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunk_size;
        const end = Math.min(start + chunk_size, file.size);
        const chunk = file.slice(start, end);

        const buffer = await chunk.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const checksum = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

        await api.put(`/uploads/${upload_id}/parts/${i}`, chunk, {
          'X-Upload-Token': upload_token,
          'X-Part-Checksum': checksum,
        });

        setProgress(Math.round(((i + 1) / totalChunks) * 100));
      }

      await api.post(`/uploads/${upload_id}/complete`, {}, {
        'X-Upload-Token': upload_token,
      });

      onUploadComplete();
    } catch (err) {
      console.error('Upload failed:', err);
      alert('上传失败');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }, [onUploadComplete, folderId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
        isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
      }`}
    >
      <input {...getInputProps()} />
      {uploading ? (
        <div>
          <div className="text-lg mb-2">上传中... {progress}%</div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : (
        <div>
          <p className="text-lg">拖拽文件到此处，或点击选择文件</p>
          <p className="text-sm text-gray-500 mt-2">支持大文件分块上传</p>
        </div>
      )}
    </div>
  );
}
