import {
  CopyObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3,
} from "@aws-sdk/client-s3";
import fs from "fs/promises";
import { env } from "./env";
import path from "path";
import { createReadStream } from "fs";

const client = new S3({
  region: env.REGION,
  credentials: {
    accessKeyId: env.ACCESS_KEY,
    secretAccessKey: env.SECRET_KEY,
  },
});

const templateExists = async (name: string) => {
  const command = new ListObjectsV2Command({
    Bucket: env.BUCKET,
    Prefix: `${name}/`,
    MaxKeys: 1,
  });

  const result = await client.send(command);
  if (!result.Contents) return false;
  const exists = result.Contents.length > 0;

  return exists;
};

export const seedTemplates = async () => {
  console.log("[seeder]: Starting");

  const templatesDir = "templates";
  const templates = await fs.readdir(templatesDir);

  for (const template of templates) {
    const exists = await templateExists(`${templatesDir}/${template}`);
    const s3Path = path.join(templatesDir, template);

    if (exists) {
      console.log(`[seeder]: ${template} already exists in s3`);

      continue;
    }

    const uploadFilesRecursive = async (dirName: string) => {
      const contents = await fs.readdir(dirName, { withFileTypes: true });

      for (const c of contents) {
        const p = path.join(dirName, c.name);

        if (c.isDirectory()) {
          uploadFilesRecursive(p);
        } else {
          const command = new PutObjectCommand({
            Bucket: env.BUCKET,
            Key: p,
            // Key: `${p.substring(templatesDir.length + 1)}`,
            Body: createReadStream(path.resolve(dirName, c.name)),
          });

          await client.send(command);
        }
      }
    };

    uploadFilesRecursive(s3Path);

    console.log(`[seeder]: ${template} successfuly seeded to s3`);
  }
};

export async function copyS3Folder(
  sourcePrefix: string,
  destinationPrefix: string,
  continuationToken?: string
): Promise<void> {
  try {
    // List all objects in the source folder
    const listParams = new ListObjectsV2Command({
      Bucket: env.BUCKET,
      Prefix: sourcePrefix,
      ContinuationToken: continuationToken,
    });

    const listedObjects = await client.send(listParams);

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) return;

    // Copy each object to the new location
    // We're doing it parallely here, using promise.all()
    await Promise.all(
      listedObjects.Contents.map(async (object) => {
        if (!object.Key) return;
        const destinationKey = object.Key.replace(
          sourcePrefix,
          destinationPrefix
        );

        const copyParams = new CopyObjectCommand({
          Bucket: env.BUCKET ?? "",
          CopySource: `${env.BUCKET}/${object.Key}`,
          Key: destinationKey,
        });

        await client.send(copyParams);
        console.log(`Copied ${object.Key} to ${destinationKey}`);
      })
    );

    // Check if the list was truncated and continue copying if necessary
    if (listedObjects.IsTruncated) {
      // listParams.ContinuationToken = listedObjects.NextContinuationToken;
      await copyS3Folder(
        sourcePrefix,
        destinationPrefix,
        listedObjects.NextContinuationToken
      );
    }
  } catch (error) {
    console.error("Error copying folder:", error);
  }
}
