const cv2 = document.createElement("canvas");
cv2.width = W; cv2.height = H;
cv2.getContext("2d").drawImage(cv, 0, 0);
return cv2.toDataURL("image/png").split(",")[1];
