import { S3Client } from "@aws-sdk/client-s3";


export const r2 = new S3Client({
    region: "auto",
    maxAttempts: 2,
    requestHandler: {
        connectionTimeout: 2000,
        requestTimeout: 3000,
        throwOnRequestTimeout: true,
        socketTimeout: 3000,
    },

    endpoint: process.env.R2_ENDPOINT,

    credentials:{
        accessKeyId:
            process.env.R2_ACCESS_KEY_ID!,

        secretAccessKey:
            process.env.R2_SECRET_ACCESS_KEY!,
    }
});
