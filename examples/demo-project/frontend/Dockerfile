FROM node:9-alpine

ENV PORT=8080
EXPOSE ${PORT}
WORKDIR /app

RUN npm install -g nodemon

COPY package.json /app
RUN npm install

COPY . /app

CMD ["npm", "start"]
