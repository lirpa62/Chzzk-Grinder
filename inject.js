(function () {
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  // 페이지 이동 감지 (SPA 대응)
  // pushState, replaceState, popstate 이벤트를 훅하여 URL 변경 시 알림을 보냄
  const pushState = history.pushState;
  const replaceState = history.replaceState;

  function notifyUrlChange() {
    window.postMessage({ type: "CHZZK_URL_CHANGED" }, "*");
  }

  history.pushState = function () {
    pushState.apply(history, arguments);
    notifyUrlChange();
  };

  history.replaceState = function () {
    replaceState.apply(history, arguments);
    notifyUrlChange();
  };

  window.addEventListener("popstate", notifyUrlChange);

  // URL 저장을 위한 open 후킹
  XHR.open = function (method, url) {
    this._url = url;
    return originalOpen.apply(this, arguments);
  };

  // 데이터 로드 완료 감지를 위한 send 후킹
  XHR.send = function (body) {
    this.addEventListener("load", function () {
      const url = this._url ? this._url.toString() : "";

      // 1. 댓글 API 감지
      if (url.includes("/comments") && url.includes("nng_comment_api")) {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ type: "CHZZK_XHR_DATA", payload: data }, "*");
        } catch (e) {
          // JSON 파싱 실패는 조용히 무시
        }
      }

      // 2. 프로필 카드 API 감지 (라이브: STREAMING, 다시보기: VIDEO 등 모든 chatType 허용)
      if (url.includes("/profile-card") && url.includes("chatType=")) {
        try {
          const data = JSON.parse(this.responseText);
          if (data.code === 200 && data.content) {
            window.postMessage(
              {
                type: "CHZZK_PROFILE_DATA",
                payload: data.content,
              },
              "*"
            );
          }
        } catch (e) {}
      }
    });
    return originalSend.apply(this, arguments);
  };

  // 차단된 유저 UID 목록 (content.js와 동기화)
  let blockedChatUsers = new Set();

  // content.js에서 차단 목록 업데이트 수신
  window.addEventListener("message", (event) => {
    if (event.data.type === "CHZZK_UPDATE_CHAT_BLOCK_LIST") {
      blockedChatUsers = new Set(event.data.payload);
    }
  });

  // JSON.parse 후킹: 데이터가 렌더링 되기 전에 가로채서 필터링
  const originalJSONParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const data = originalJSONParse(text, reviver);

    try {
      if (data && typeof data === "object") {
        // 1. 실시간 채팅 (CMD 93101)
        if (data.cmd === 93101 && Array.isArray(data.bdy)) {
          // 차단된 유저의 메시지는 배열에서 제외(filter)
          data.bdy = data.bdy.filter((msg) => !blockedChatUsers.has(msg.uid));
        }
        // 2. 과거 채팅 내역 (CMD 15101)
        else if (
          data.cmd === 15101 &&
          data.bdy &&
          Array.isArray(data.bdy.messageList)
        ) {
          data.bdy.messageList = data.bdy.messageList.filter((msg) => {
            // userId 혹은 profile 문자열 내부의 userIdHash 확인
            const uid =
              msg.userId ||
              (msg.profile ? originalJSONParse(msg.profile).userIdHash : null);
            return !blockedChatUsers.has(uid);
          });
        }
      }
    } catch (e) {
      // 파싱 중 에러 발생 시 무시하고 원본 데이터 반환
    }

    return data;
  };

  // VOD 다시보기 채팅 API URL 매칭 정규식
  // 예: https://api.chzzk.naver.com/service/v1/videos/12345/chats?...
  const VOD_CHAT_URL_RE =
    /^https:\/\/api\.chzzk\.naver\.com\/service\/v\d+\/videos\/\d+\/chats(?:[/?#]|$)/i;

  // VOD 채팅 응답에서 차단 유저 메시지 필터링
  function filterVodChatResponse(data) {
    if (!data || typeof data !== "object") return;
    const content = data.content;
    if (!content || typeof content !== "object") return;

    if (Array.isArray(content.previousVideoChats)) {
      content.previousVideoChats = content.previousVideoChats.filter(
        (msg) => msg && !blockedChatUsers.has(msg.userIdHash)
      );
    }
    if (Array.isArray(content.videoChats)) {
      content.videoChats = content.videoChats.filter(
        (msg) => msg && !blockedChatUsers.has(msg.userIdHash)
      );
    }
  }

  function isVodChatRequestUrl(url) {
    return VOD_CHAT_URL_RE.test(String(url || ""));
  }

  function resolveRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  // 3. 클립 메타데이터 + VOD 채팅 API 감지 (fetch)
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const requestUrl = resolveRequestUrl(args[0]);
    const isVodChat = isVodChatRequestUrl(requestUrl);

    // VOD 채팅: 응답 본문을 직접 가로채서 차단 유저 메시지 제거 후 새 Response 반환
    if (isVodChat) {
      const response = await originalFetch.apply(this, args);
      try {
        const cloned = response.clone();
        const data = await cloned.json();
        filterVodChatResponse(data);

        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        // 파싱 실패 시 원본 응답 그대로 반환
        return response;
      }
    }

    // 그 외 요청: 기존 로직 유지
    const response = await originalFetch.apply(this, args);

    if (
      response.url &&
      response.url.includes("/shortformhub") &&
      response.url.includes("/card") &&
      response.url.includes("seedType=SPECIFIC")
    ) {
      try {
        const clone = response.clone();
        clone
          .json()
          .then((data) => {
            try {
              if (data && data.card) {
                const payload = {
                  streamerName:
                    data.card.interaction?.subscription?.name || "알 수 없음",
                  title: data.card.content?.title || "제목 없음",
                  clipId: data.card.content?.contentId || "",
                };

                window.postMessage(
                  { type: "CHZZK_CLIP_METADATA", payload: payload },
                  "*"
                );
              }
            } catch (e) {}
          })
          .catch(() => {});
      } catch (e) {}
    }

    return response;
  };

  // 4. VOD 채팅 API 감지 (XHR)
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    const xhrOpen = OriginalXHR.prototype.open;
    const xhrSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url) {
      this.__chzzkVodChatUrl = isVodChatRequestUrl(url) ? String(url) : "";
      return xhrOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function () {
      if (this.__chzzkVodChatUrl) {
        // responseText를 가로채 필터링된 JSON으로 덮어쓴다.
        // getter 재정의로 원본 응답을 건드리지 않고 sites가 읽는 값만 교체.
        const xhr = this;
        xhr.addEventListener("load", function () {
          try {
            const raw = xhr.responseText;
            if (!raw) return;
            const data = originalJSONParse(raw);
            filterVodChatResponse(data);
            const filteredText = JSON.stringify(data);

            Object.defineProperty(xhr, "responseText", {
              configurable: true,
              get() {
                return filteredText;
              },
            });
            Object.defineProperty(xhr, "response", {
              configurable: true,
              get() {
                // responseType이 'json'인 경우 객체 반환
                if (xhr.responseType === "json") return data;
                return filteredText;
              },
            });
          } catch (e) {
            // 실패 시 원본 응답 그대로 노출
          }
        });
      }
      return xhrSend.apply(this, arguments);
    };
  }
})();
