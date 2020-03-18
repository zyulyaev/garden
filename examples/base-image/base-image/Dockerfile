FROM golang:1.11.9-alpine3.9

ENV PORT=8080
EXPOSE ${PORT}
WORKDIR /app

ONBUILD COPY main.go .
ONBUILD RUN go build -o main .

ENTRYPOINT ["./main"]
