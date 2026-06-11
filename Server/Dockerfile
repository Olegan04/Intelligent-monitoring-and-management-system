FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -o server .

FROM alpine:3.21

WORKDIR /app

COPY --from=builder /app/server .

EXPOSE 8080 8081

CMD ["./server"]