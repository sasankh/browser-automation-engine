#!/bin/bash
# LocalStack init hook (runs once LocalStack is ready): create the S3 bucket + SQS queues for the
# Phase 6 cloud topology. The main run queue gets a redrive policy → DLQ after maxReceiveCount.
awslocal s3 mb s3://rote || true

awslocal sqs create-queue --queue-name rote-dlq || true
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/rote-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

RUNS_URL=$(awslocal sqs create-queue --queue-name rote-runs --query QueueUrl --output text)
cat > /tmp/redrive.json <<EOF
{
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}",
  "VisibilityTimeout": "120"
}
EOF
awslocal sqs set-queue-attributes --queue-url "$RUNS_URL" --attributes file:///tmp/redrive.json

awslocal sqs create-queue --queue-name rote-results || true

echo "localstack init: bucket + queues ready"
