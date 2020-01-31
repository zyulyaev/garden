FROM node:9-alpine

ENV PORT=8080
EXPOSE ${PORT}
WORKDIR /app

RUN apk add --no-cache postgresql-client


COPY package.json /app
RUN npm install

COPY . /app

CMD ["npm", "start"]
